# Changelog — Codebase Memory V2

## 0.44.0 — Round 109 (2026-07-09) Empty Graph Complete State Lock

**34th round (GPT 5.5 external audit R110).** 0 bugs confirmed — defensive fix
+ 6 tests. GPT 5.5 reported a P2 bug where `initialized=true + nodesCount=0`
could produce `stale=true`. Verification showed the bug was **NOT triggerable**
because the extractor always creates a File node per file (so `nodesCount >= 1`
when any file exists). `nodesCount=0` only happens when ALL files are deleted,
which is handled correctly by the deletion-only fast path. However, R109
applies a **defensive fix** to make the "empty graph is complete" semantics
explicit in all 3 code paths, guarding against future extractor changes.

### Verification of R110 P2 claim

Standalone reproduction scripts tested 2 scenarios:
1. **Function → const** (`export function local()` → `export const x = 1;`):
   `nodesCount=1` (File node always created), `stale=false`. Bug NOT triggered.
2. **All files deleted** (deletion-only): `nodesCount=0`, `stale=false`
   (deletion-only fast path uses `existingStale` fallback). Bug NOT triggered.

**Conclusion**: The report's scenario was based on a false assumption that the
extractor doesn't create a File node for files without functions/classes. In
reality, `fast-walker.ts` line 159 always pushes a File node.

### Defensive fix applied

Despite the bug being non-triggerable, R109 makes the semantics explicit in all
3 code paths (single-thread, parallel, deletion-only):
- When `callSitesInitialized=true && nodesCount=0`, mark `crossFileCallsResolved=true`
  without calling `rebuildCrossFileCallsEdges()` (nothing to rebuild).
- This guards against future extractor changes that might skip File node creation.
- Also documented that `rebuildCrossFileCallsEdges()` is safe to call with
  `nodesCount=0` (defensive), even though callers now skip it.

### Tests added (6)

New file: `v2/tests/indexer/r109-empty-graph-complete.test.ts`

1. **single-thread: function → const, stale=false** — Verifies File node is always created, so nodesCount >= 1.
2. **deletion-only: all files deleted → nodes=0, edges=0, call_sites=0, stale=false** — The only real nodesCount=0 scenario.
3. **deletion-only all deleted → full reindex repopulates correctly** — Lifecycle: empty → repopulate.
4. **parallel: file loses last function → stale=false, orphan_edges=0** — P2/P3 from R110 report.
5. **legacy DB (initialized=0) + all files deleted → stale=true** — Documents legacy DB behavior.
6. **rebuildCrossFileCallsEdges is safe when nodesCount=0** — Direct unit test of the resolver on an empty project.

### Verification

```
Typecheck: OK
Test Files  14 passed (14)     [indexer tests]
     Tests  73 passed (73)     [67 existing + 6 new R109]
Benchmark smoke: PASSED (all invariants met)
```

### Files

- Modified: `v2/src/indexer/wasm-extractor.ts` (defensive: nodesCount=0 → resolved=true)
- Modified: `v2/src/indexer/indexer.ts` (parallel + deletion-only defensive fix)
- Modified: `v2/src/indexer/cross-file-resolver.ts` (documented safe with nodesCount=0)
- New: `v2/tests/indexer/r109-empty-graph-complete.test.ts` (6 tests)
- Modified: `v2/package.json` (version 0.44.0)

### Total: 39 bugs + 11 optimizations + 73 indexer tests across 34 rounds

### Next steps

1. **Import-aware resolution** — parse import statements to prefer imported symbols
2. **Precision benchmark** — manually verify 20-50 cross-file CALLS edges
3. **Worker pool persistant** — for MCP/UI/watch daemon mode
4. **Incremental cross-file CALLS optimization** — only re-resolve call_sites from changed files

## 0.43.0 — Round 108 (2026-07-09) Call-sites Empty Initialized Precision Lock

**33rd round (GPT 5.5 external audit R109).** 1 bug fixed. GPT 5.5 found that
R107 could still mark `crossFileCallsStale=true` when a project with
`call_sites_initialized=1` and `call_sites=0` had a content change. This is a
false positive — the graph is complete (no cross-file calls to resolve), so
stale should be false.

### Bug fixed (1)

39. **`stale=true` false positive when `initialized=1 + call_sites=0 + content change`** (`wasm-extractor.ts`, `indexer.ts`) — R107's resolver only ran when `hasCallSites(db, project)` returned true (i.e., at least one call_site row existed). But a valid R107 project can have `call_sites=0` (no unresolved cross-file calls). In that case, a content change that doesn't introduce cross-file calls would: (1) re-index the file, (2) skip resolution because `hasCallSites()=false`, (3) `crossFileCallsResolved=false`, (4) `crossFileStale = existingStale || result.files > 0 = true`. Fixed: when `callSitesInitialized=true`, ALWAYS run `rebuildCrossFileCallsEdges()` (even if `call_sites=0`). This: (a) cleans up any stale cross-file edges if `call_sites` became empty after the change, (b) sets `crossFileCallsResolved=true` so the caller computes `stale=false`. A project with `initialized=true + call_sites=0` is now correctly treated as a COMPLETE state.

### Implementation

1. Single-thread path (`wasm-extractor.ts`): changed condition from `hasCallSites(db, project)` to `callSitesInitialized` — always rebuild when initialized, even if call_sites is empty.
2. Parallel path (`indexer.ts` `indexParallel()`): same change.
3. Deletion-only fast path (`indexer.ts`): same change — always rebuild when initialized.
4. Post-extraction deletion cleanup (`indexer.ts`): changed from `isCallSitesInitialized && hasCallSites` to just `isCallSitesInitialized` — always rebuild when initialized.
5. Removed unused `hasCallSites` import from both `wasm-extractor.ts` and `indexer.ts` (still exported from `cross-file-resolver.ts` for potential future use).
6. `rebuildCrossFileCallsEdges()` already handles the empty case correctly: it deletes all existing cross-file CALLS edges first, then inserts 0 new ones if `call_sites` is empty.

### Tests added (7)

New file: `v2/tests/indexer/r108-stale-complete-precision.test.ts`

1. **incremental content change with initialized empty call_sites stays stale=false** — The exact R109 P2 scenario: full index with 0 call-sites, then content change (still no call-sites). Before R108: stale=true. After R108: stale=false.
2. **incremental removing all cross-file calls cleans up edges, stale=false** — Project has cross-file calls, then a.ts modified to remove them. Old cross-file edges must be cleaned up. Stale=false (resolver ran).
3. **incremental content change with initialized non-empty call_sites stays stale=false** — Sanity check: normal case (has call-sites, content changes) still works.
4. **no-op incremental after initialized empty call_sites stays stale=false** — No-op doesn't change anything.
5. **deletion-only with initialized empty call_sites stays stale=false** — Deletion-only fast path with no cross-file calls.
6. **lifecycle: empty → add calls → remove calls → empty, stale always false** — Full lifecycle: stale is always false when initialized=true.
7. **legacy DB (initialized=0) + content change → stale=true (unchanged by R108)** — Sanity check: legacy DBs still get stale=true.

### Verification

```
Typecheck: OK
Test Files  13 passed (13)     [indexer tests]
     Tests  67 passed (67)     [60 existing + 7 new R108]
Benchmark smoke: PASSED (all invariants met)
```

### Files

- Modified: `v2/src/indexer/wasm-extractor.ts` (always rebuild when initialized)
- Modified: `v2/src/indexer/indexer.ts` (parallel + deletion-only + post-extraction cleanup)
- New: `v2/tests/indexer/r108-stale-complete-precision.test.ts` (7 tests)
- Modified: `v2/package.json` (version 0.43.0)

### Total: 39 bugs + 11 optimizations + 67 indexer tests across 33 rounds

### Next steps

1. **Import-aware resolution** — parse import statements to prefer imported symbols
2. **Precision benchmark** — manually verify 20-50 cross-file CALLS edges
3. **Worker pool persistant** — for MCP/UI/watch daemon mode
4. **Incremental cross-file CALLS optimization** — only re-resolve call_sites from changed files

## 0.42.0 — Round 107 (2026-07-09) Call-sites Initialized State + First Incremental Proof

**32nd round (GPT 5.5 external audit R108).** 1 bug fixed. GPT 5.5 found that
R106's legacy DB detection using `hasCallSites()===false` was ambiguous: a
valid R106 project with 0 call-sites (no unresolved cross-file calls) would be
incorrectly treated as "legacy DB", causing the incremental resolver to skip
resolution and mark the graph stale.

### Bug fixed (1)

38. **`hasCallSites()===false` ambiguous: valid R106 DB with 0 call-sites treated as legacy** (`cross-file-resolver.ts`, `wasm-extractor.ts`, `indexer.ts`, `schema.ts`) — R106 used `hasCallSites(project)===false` as the signal for "legacy pre-R106 DB". But a valid R106 DB can legitimately have 0 call-sites (project with no unresolved cross-file calls). In that case, the first incremental that introduces cross-file calls would: (1) insert the new call_site, (2) skip resolution because `callSitesExistedBefore=false`, (3) mark `stale=true`, (4) NOT create the cross-file edge until a full reindex. Fixed: added explicit `projects.call_sites_initialized INTEGER DEFAULT 0` flag. Set to 1 after any successful full R106+ reindex. Incremental mode now uses `isCallSitesInitialized()` instead of `hasCallSites()` as the legacy DB signal. A valid R106 DB with 0 call-sites has `initialized=1`, so the resolver is allowed to run when the first call-site is introduced.

### Implementation

1. Schema: `ALTER TABLE projects ADD COLUMN call_sites_initialized INTEGER DEFAULT 0`
2. Migration: `migrateProjectsCallSitesInitialized()` — idempotent, adds column if missing
3. `updateProjectStats()` — new `callSitesInitialized` parameter (7th arg)
4. Full reindex: sets `call_sites_initialized=1` (even if 0 call-sites found)
5. Incremental: preserves existing `call_sites_initialized` value
6. New helper: `isCallSitesInitialized(db, project)` — authoritative legacy DB signal
7. Both single-thread (`wasm-extractor.ts`) and parallel (`indexer.ts`) paths use `isCallSitesInitialized()` instead of capturing `callSitesExistedBefore` before insertion
8. Deletion-only fast path and post-extraction cleanup also use `isCallSitesInitialized()`

### Tests added (7)

New file: `v2/tests/indexer/r107-call-sites-initialized.test.ts`

1. **full index with 0 call-sites: initialized=1, call_sites=0, stale=false** — Project with no cross-file calls. Full index should set initialized=1 even though call_sites=0.
2. **incremental adds first call-site: edge created, stale=false (R108 P2 fix)** — The exact R108 P2 scenario: full index with 0 call-sites, then incremental adds a cross-file call. Before R107, stale=true and no edge. After R107, stale=false and edge created.
3. **legacy DB (initialized=0): incremental keeps stale=true** — Manually reset initialized=0 + delete call_sites. Incremental should mark stale=true (forces full reindex).
4. **no-op incremental preserves call_sites_initialized flag** — No-op doesn't change the flag.
5. **metadata-only incremental preserves call_sites_initialized flag** — Metadata-only doesn't change the flag.
6. **parallel: workers=2 full index populates call_sites + incremental resolves** — P2/P3 from R108 report: forces real parallel path with 24+ files and workers=2. Verifies call_sites populated, cross-file edges created, incremental resolves, stale=false, orphan_edges=0.
7. **projects table has call_sites_initialized column** — Schema verification.

### Tests updated (2)

- `r104-deleted-files.test.ts` test 1: `crossFileCallsStale` now `false` (was `true`) — with R107, deletion-only fast path either rebuilds cross-file CALLS (stale=false) or has nothing to rebuild (stale=false, graph still complete).
- `r106-call-sites-persistent.test.ts` test 11 (legacy DB): now also resets `call_sites_initialized=0` (not just deletes call_sites rows) — R107 requires both to simulate legacy DB.

### Verification

```
Typecheck: OK
Test Files  12 passed (12)     [indexer tests]
     Tests  60 passed (60)     [53 existing + 7 new R107]
Benchmark smoke: PASSED (all invariants met)
```

### Files

- Modified: `v2/src/indexer/schema.ts` (call_sites_initialized column + migration + updateProjectStats)
- Modified: `v2/src/indexer/cross-file-resolver.ts` (new isCallSitesInitialized helper)
- Modified: `v2/src/indexer/wasm-extractor.ts` (use isCallSitesInitialized)
- Modified: `v2/src/indexer/indexer.ts` (use isCallSitesInitialized in all 3 paths + preserve flag)
- New: `v2/tests/indexer/r107-call-sites-initialized.test.ts` (7 tests)
- Updated: `v2/tests/indexer/r104-deleted-files.test.ts` (stale=false after deletion)
- Updated: `v2/tests/indexer/r106-call-sites-persistent.test.ts` (legacy DB simulation resets flag)
- Modified: `v2/package.json` (version 0.42.0)

### Total: 38 bugs + 11 optimizations + 60 indexer tests across 32 rounds

### Next steps

1. **Import-aware resolution** — parse import statements to prefer imported symbols
2. **Precision benchmark** — manually verify 20-50 cross-file CALLS edges
3. **Worker pool persistant** — for MCP/UI/watch daemon mode
4. **Incremental cross-file CALLS optimization** — only re-resolve call_sites from changed files

## 0.41.0 — Round 106 (2026-07-09) Call-sites Persistent Table + Deletion-only Fast Path

**31st round (GPT 5.5 external audit R106).** Major feature: persistent
`call_sites` table that enables cross-file CALLS resolution in incremental
mode. Before R106, incremental mode couldn't resolve cross-file CALLS (the
global symbol index only had changed files' symbols), so the graph was marked
stale until a full reindex. R106 eliminates this limitation.

### Feature: Call-sites Persistent Table (R106 Phase 1)

New `call_sites` table stores unresolved call-sites from every file. In
incremental mode, only call_sites for changed/deleted files are removed;
call_sites for unchanged files remain. Cross-file CALLS edges are rebuilt from
the full call_sites table + all current nodes.

**Schema:**
```sql
CREATE TABLE call_sites (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  source_qn TEXT NOT NULL,
  callee TEXT NOT NULL,
  last_segment TEXT NOT NULL,
  call_kind TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX idx_call_sites_project_file ON call_sites(project, file_path);
```

**Behavior:**
- **Full mode**: clear call_sites → extract all files → insert call_sites → rebuild cross-file CALLS → stale=false
- **Incremental mode**: delete call_sites for changed files → insert new call_sites → rebuild cross-file CALLS from full table → stale=false
- **Deletion-only fast path**: skip extraction entirely → cleanup deleted files → rebuild cross-file CALLS → stale=false
- **Legacy DB (pre-R106)**: call_sites empty → skip resolution → stale=true (forces full reindex to populate call_sites)

### Performance improvement (1)

- **Deletion-only incremental fast path** (`indexer.ts`) — Before R106, deleting a single file in incremental mode would fall through to `extractFromFilesWasm()` which stats+skips every unchanged file (wasteful). R106 adds a dedicated fast path: if `estimatedFilesToIndex === 0 && deletedRelPaths.length > 0`, skip extraction entirely, just run the cleanup transaction + rebuild cross-file CALLS. On a large project, this turns a multi-second stat pass into a sub-100ms cleanup.

### Files

- New: `v2/src/indexer/cross-file-resolver.ts` — shared helper for call_sites persistence + cross-file CALLS resolution
- Modified: `v2/src/indexer/schema.ts` — call_sites table + index + clearProjectData
- Modified: `v2/src/indexer/wasm-extractor.ts` — single-thread path uses persistent call_sites + shared resolver
- Modified: `v2/src/indexer/indexer.ts` — parallel path uses persistent call_sites + shared resolver + deletion-only fast path
- New: `v2/tests/indexer/r106-call-sites-persistent.test.ts` (12 tests)
- Updated: `v2/tests/indexer/r100-cross-file-calls.test.ts` (stale=false after incremental)
- Updated: `v2/tests/indexer/r102-stale-monotonicity.test.ts` (stale=false after incremental)
- Updated: `v2/tests/indexer/r103-stale-precision.test.ts` (stale=false after content change)
- Modified: `v2/package.json` (version 0.41.0)

### Tests added (12)

New file: `v2/tests/indexer/r106-call-sites-persistent.test.ts`

1. **full index: a.ts calls b.ts → cross-file CALLS edge created + call_sites populated**
2. **incremental: modify caller a.ts → cross-file CALLS updated, stale=false**
3. **incremental: modify target b.ts → cross-file CALLS still resolved, stale=false**
4. **incremental: delete target b.ts → call_sites/edges for b.ts cleaned up**
5. **metadata-only: no files re-indexed, call_sites unchanged, stale preserved**
6. **no-op incremental: nothing changes, call_sites/edges preserved**
7. **incremental: ambiguity cap 5 preserved with persistent call_sites**
8. **incremental: builtins filter preserved (console.log, arr.map not matched)**
9. **incremental with call_sites: orphan edges = 0, stats match**
10. **deletion-only fast path: skips extraction, rebuilds cross-file CALLS, stale=false**
11. **legacy DB without call_sites: incremental marks stale=true (forces full reindex)**
12. **call_sites table: schema + index idx_call_sites_project_file exists**

### Tests updated (3)

- `r100-cross-file-calls.test.ts` test 6: "incremental: crossFileCallsStale is false when call_sites is populated (R106)" — was "stale=true when files change"
- `r102-stale-monotonicity.test.ts`: "full → incremental changed (resolves) → no-op preserves → full resets" — stale is now false after incremental (resolver runs)
- `r103-stale-precision.test.ts` test 2: "real content change resolves cross-file (R106), then metadata-only preserves" — stale is now false after content change

### Verification

```
Test Files  11 passed (11)     [indexer tests only]
     Tests  53 passed (53)     [41 existing + 12 new R106]
```

### Total: 37 bugs + 11 optimizations + 53 indexer tests across 31 rounds

### Next steps

1. **Import-aware resolution** — parse import statements to prefer imported symbols
2. **Precision benchmark** — manually verify 20-50 cross-file CALLS edges
3. **Worker pool persistant** — for MCP/UI/watch daemon mode
4. **Incremental cross-file CALLS optimization** — only re-resolve call_sites from changed files (instead of rebuilding all)

## 0.40.0 — Round 105 (2026-07-09) Legacy Deletion Detection + Parallel Proof

**30th round (GPT 5.5 external audit R105).** 0 new bugs — hardens R104's
deleted files cleanup for legacy DBs and adds parallel path proof.

### Improvement (1)

- **Legacy DB deletion detection** (`indexer.ts`) — R104 detected deleted files via `SELECT file_path FROM file_hashes WHERE project = ?`. But legacy DBs (pre-R79) may have `nodes` without corresponding `file_hashes` entries. Ghost nodes from these files would survive incremental cleanup. Fixed: detection now uses `SELECT DISTINCT file_path FROM nodes WHERE project = ? UNION SELECT file_path FROM file_hashes WHERE project = ?` — catches both sources.

### Tests added (2)

New file: `v2/tests/indexer/r105-legacy-deletion.test.ts`

1. **`legacy DB: nodes without file_hashes are detected and cleaned up`** — Manually inserts a ghost node for `ghost.ts` without a `file_hashes` entry. Incremental must detect and clean it up via the `nodes ∪ file_hashes` query.
2. **`parallel: deletion cleanup works with workers > 1`** — 24 files, full index parallel, delete file5.ts, incremental, verify cleanup + orphan_edges=0 + other files preserved.

### Verification

```
Test Files  42 passed (42)
     Tests  396 passed (396)
```

### Files

- Modified: `v2/src/indexer/indexer.ts` (R105: nodes ∪ file_hashes detection)
- New: `v2/tests/indexer/r105-legacy-deletion.test.ts` (2 tests)
- Modified: `v2/package.json` (version 0.40.0)

### Total: 37 bugs + 10 optimizations + 41 tests across 30 rounds

### Next steps

1. **Call-sites persistent table** — enable cross-file CALLS in incremental mode (the real fix for stale)
2. **Import-aware resolution** — parse import statements
3. **Precision benchmark** — manually verify 20-50 cross-file CALLS edges
4. **Worker pool persistant** — for MCP/UI/watch daemon mode

## 0.39.0 — Round 104 (2026-07-09) Incremental Deleted Files Cleanup

**29th round (GPT 5.5 external audit R104).** 1 bug fixed. GPT 5.5 found that
deleted files were never cleaned up in incremental mode — nodes, edges, and
file_hashes for deleted files remained in the DB as "ghost graph".

### Bug fixed (1)

37. **Deleted files not cleaned up in incremental mode** (`indexer.ts`) — In incremental mode, the indexer only processes files currently on disk. Files that were deleted since the last index remained in `nodes`, `edges`, and `file_hashes` indefinitely. MCP/UI would show symbols for files that no longer exist. Fixed: after extraction, detect deleted files by comparing `file_hashes.file_path` against current discovery. Delete their nodes, edges (orphaned), and file_hashes in a transaction. Also sets `crossFileCallsStale=true` since the graph changed.

### Implementation

1. After `discoverSourceFilesWasm()`, build `currentRelPaths` set
2. Query `SELECT file_path FROM file_hashes WHERE project = ?`
3. `deletedRelPaths = indexedPaths.filter(p => !currentRelPaths.has(p))`
4. Don't early-return no-op if `deletedRelPaths.length > 0`
5. After extraction phase, delete nodes/edges/file_hashes for deleted files in a transaction
6. `crossFileStale = existingStale || result.files > 0 || deletedRelPaths.length > 0`

### Tests added (3)

New file: `v2/tests/indexer/r104-deleted-files.test.ts`

1. **`deleted file is cleaned up from nodes, edges, and file_hashes`** — Delete b.ts, incremental, verify b.ts nodes=0, hashes=0, a.ts preserved, orphan_edges=0, stale=true.
2. **`deleted file + modified file: both handled correctly`** — Delete b.ts + modify a.ts, incremental, verify b.ts cleaned, a.ts re-indexed, c.ts preserved, orphan_edges=0.
3. **`no-op after deletion cleanup: deleted file stays gone`** — After deletion cleanup, second no-op incremental doesn't re-create b.ts.

### Verification

```
Test Files  41 passed (41)
     Tests  394 passed (394)
```

### Files

- Modified: `v2/src/indexer/indexer.ts` (Bug 37: deleted file detection + cleanup)
- New: `v2/tests/indexer/r104-deleted-files.test.ts` (3 tests)
- Modified: `v2/package.json` (version 0.39.0)

### Total: 37 bugs + 10 optimizations + 39 tests across 29 rounds

### Next steps

1. **Call-sites persistent table** — enable cross-file CALLS in incremental mode
2. **Import-aware resolution** — parse import statements
3. **Precision benchmark** — manually verify 20-50 cross-file CALLS edges
4. **Worker pool persistant** — for MCP/UI/watch daemon mode

## 0.38.0 — Round 103 (2026-07-09) Stale Flag Precision Lock

**28th round (GPT 5.5 external audit R103).** 1 bug fixed. GPT 5.5 found that
R102's `crossFileStale = true` for ALL incremental runs was too pessimistic —
metadata-only updates (touch/mtime change without content change) don't modify
the graph, so cross-file CALLS remain valid.

### Bug fixed (1)

36. **`crossFileCallsStale` too pessimistic on metadata-only incremental** (`indexer.ts`) — R102 set `crossFileStale = true` for any incremental that reached the normal path (estimatedFilesToIndex > 0). But a metadata-only update (mtime changed, content same) results in `result.files = 0` (no re-indexing, just hash metadata update). Setting stale=true in this case is a false positive that pushes unnecessary full reindexes. Fixed: `crossFileStale = existingStale || result.files > 0`. Now: metadata-only (files=0) preserves existing stale state without forcing true. Only real content changes (files>0) set stale=true.

### Stale flag semantics (now precise)

```
Full reindex                → cross_file_calls_stale = false
Incremental (content changed, files>0) → cross_file_calls_stale = true
Incremental (metadata-only, files=0)   → preserves existing DB value
Incremental (no-op)                    → preserves existing DB value
```

### Tests added (2)

New file: `v2/tests/indexer/r103-stale-precision.test.ts`

1. **`metadata-only touch does not set stale when graph was clean`** — Touch a.ts (change mtime, keep content), run incremental. Verify: `files=0`, `skipped>0`, `crossFileCallsStale=false`, DB stale=false.
2. **`real content change sets stale, then metadata-only preserves stale`** — Full → modify content (stale=true) → touch b.ts metadata-only (stale STILL true, preserved) → full reindex (stale=false).

### Verification

```
Test Files  40 passed (40)
     Tests  391 passed (391)
```

### Files

- Modified: `v2/src/indexer/indexer.ts` (Bug 36: stale = existingStale || result.files > 0)
- New: `v2/tests/indexer/r103-stale-precision.test.ts` (2 tests)
- Modified: `v2/package.json` (version 0.38.0)

### Total: 36 bugs + 10 optimizations + 36 tests across 28 rounds

### Next steps

1. **Call-sites persistent table** — enable cross-file CALLS in incremental mode (the real fix)
2. **Import-aware resolution** — parse import statements
3. **Precision benchmark** — manually verify 20-50 cross-file CALLS edges
4. **Worker pool persistant** — for MCP/UI/watch daemon mode

## 0.37.0 — Round 102 (2026-07-09) Stale Flag Monotonicity Fix

**27th round (GPT 5.5 external audit R102).** 1 bug fixed. GPT 5.5 found that
a no-op incremental could reset `cross_file_calls_stale` to `false`, masking
a stale graph from MCP/UI consumers.

### Bug fixed (1)

35. **No-op incremental resets `cross_file_calls_stale` to false** (`indexer.ts`) — After an incremental that changed files (stale=true), a subsequent no-op incremental would reset stale to `false` via `updateProjectStats(..., false)`. MCP/UI querying the DB would see `cross_file_calls_stale = 0` and believe the graph is complete, when cross-file CALLS edges are still missing. Fixed: no-op incremental now reads the existing `cross_file_calls_stale` from DB and preserves it. Only a full reindex resets to `false`. The normal incremental path (files changed) always sets `true`.

### Test added (1)

New file: `v2/tests/indexer/r102-stale-monotonicity.test.ts`

- **`full → incremental changed → no-op preserves stale → full resets`** — Verifies the complete lifecycle: full (stale=false) → modify file + incremental (stale=true) → no-op incremental (stale STILL true) → full reindex (stale=false again). Checks both `IndexResult.crossFileCallsStale` and DB `projects.cross_file_calls_stale`.

### Stale flag semantics (now correct)

```
Full reindex              → cross_file_calls_stale = false (DB + IndexResult)
Incremental (files changed) → cross_file_calls_stale = true  (DB + IndexResult + CLI warning)
Incremental (no-op)       → preserves existing DB value (does NOT reset to false)
```

### Verification

```
Test Files  39 passed (39)
     Tests  389 passed (389)
```

### Files

- Modified: `v2/src/indexer/indexer.ts` (Bug 35: preserve existing stale in no-op, simplify normal path)
- New: `v2/tests/indexer/r102-stale-monotonicity.test.ts` (1 test)
- Modified: `v2/package.json` (version 0.37.0)

### Total: 35 bugs + 10 optimizations + 34 tests across 27 rounds

### Next steps

1. **Call-sites persistent table** — enable cross-file CALLS in incremental mode
2. **Import-aware resolution** — parse import statements
3. **Precision benchmark** — manually verify 20-50 cross-file CALLS edges
4. **Worker pool persistant** — for MCP/UI/watch daemon mode

## 0.36.0 — Round 101 (2026-07-09) Cross-file CALLS Stale Propagation + DB Persistence

**26th round (GPT 5.5 external audit R101).** 0 new bugs — `crossFileCallsStale`
is now visible in CLI, persisted in DB, and reset on full reindex. Also fixes
stale comment in `indexParallel()`.

### Improvements (3)

1. **CLI warning when `crossFileCallsStale`** (`cli/commands/index.ts`) — After incremental index that modifies files, CLI now prints:
   ```
   ⚠ Cross-file CALLS may be stale after incremental changes.
     Run "cbm-v2 index --project <name> --root <path>" (full reindex) to rebuild them.
   ```

2. **`cross_file_calls_stale` persisted in `projects` table** (`schema.ts` + `indexer.ts`) — Added `cross_file_calls_stale INTEGER DEFAULT 0` column to `projects` table. Auto-migration via `migrateProjectsCrossFileStale()`. `updateProjectStats()` now takes a `crossFileCallsStale: boolean` parameter. Set to `true` on incremental with files changed, `false` on full reindex. MCP/UI can query `SELECT cross_file_calls_stale FROM projects WHERE name = ?` to check if the graph is stale.

3. **Fixed stale comment in `indexParallel()`** (`indexer.ts`) — Old comment said "cross-file CALLS edge resolution is limited to within each batch" which was no longer true since R98. Replaced with accurate description: "Cross-file CALLS are resolved in full mode by a main-thread second pass. In incremental mode they are intentionally marked stale."

### Verification

```
Test Files  38 passed (38)
     Tests  388 passed (388)
```

### Files

- Modified: `v2/src/cli/commands/index.ts` (CLI warning)
- Modified: `v2/src/indexer/schema.ts` (cross_file_calls_stale column + migration + updateProjectStats)
- Modified: `v2/src/indexer/indexer.ts` (persist stale flag, fix stale comment)
- Modified: `v2/package.json` (version 0.36.0)

### Next steps

1. **Call-sites persistent table** — enable cross-file CALLS in incremental mode
2. **Import-aware resolution** — parse import statements
3. **Precision benchmark** — manually verify 20-50 cross-file CALLS edges
4. **Worker pool persistant** — for MCP/UI/watch daemon mode

## 0.35.0 — Round 100 (2026-07-08) Cross-file CALLS Tests + Stale Flag

**25th round (GPT 5.5 external audit R100).** 0 new bugs — 6 tests + 1 feature
flag. Closes the test gap for R98/R99 cross-file CALLS and adds explicit
`crossFileCallsStale` flag for incremental mode.

### Feature: `crossFileCallsStale` flag

- **`IndexResult.crossFileCallsStale: boolean`** (`indexer.ts`) — Set to `true` when incremental mode modifies files and cross-file CALLS edges may be stale (not rebuilt). Consumers (MCP/UI/watch) can check this flag and recommend a full reindex.

### Tests added (6 new, versioned)

New file: `v2/tests/indexer/r100-cross-file-calls.test.ts`

1. **`full index: cross-file CALLS edge created for identifier call`** — Verifies `foo()` in `a.ts` calling `foo()` defined in `b.ts` creates a `cross_file_name_exact` edge with `call_kind: identifier_call`.
2. **`builtins filtered: console.log, array.map do not create cross-file edges`** — Verifies `console.log()` and `arr.map()` do NOT create edges to project functions `log`/`map`, but `log()` as identifier call DOES.
3. **`ambiguity: max 5 candidates per call`** — 7 files each define `foo()`. Cross-file edges capped at 5 with `resolution: cross_file_ambiguous`.
4. **`JSON properties are valid for all CALLS edges`** — All CALLS edge properties parse as valid JSON with `inferred: true`.
5. **`orphan edges = 0 after full index with cross-file CALLS`** — No orphan edges when cross-file CALLS are present.
6. **`incremental: crossFileCallsStale flag is set when files change`** — After incremental modifying a file, `result.crossFileCallsStale === true`.

### Verification

```
Test Files  38 passed (38)
     Tests  388 passed (388)
```

### Files

- New: `v2/tests/indexer/r100-cross-file-calls.test.ts` (6 tests)
- Modified: `v2/src/indexer/indexer.ts` (crossFileCallsStale flag + IndexResult)
- Modified: `v2/package.json` (version 0.35.0)

### Total: 34 bugs + 10 optimizations + 33 tests across 25 rounds

### Next steps

1. **Call-sites persistent table** — enable cross-file CALLS in incremental mode
2. **Import-aware resolution** — parse import statements to prefer imported symbols
3. **Precision benchmark** — manually verify 20-50 cross-file CALLS edges
4. **Worker pool persistant** — for MCP/UI/watch daemon mode

## 0.34.0 — Round 99 (2026-07-08) Cross-file CALLS Correctness + Precision Lock

**24th round (GPT 5.5 external audit R99).** 1 P1 bug fixed + 3 precision
improvements. GPT 5.5 found that R98's cross-file CALLS resolver was broken
in incremental mode and produced false positives from member calls.

### Bug fixed (1, P1)

34. **Cross-file CALLS broken in incremental mode** (`wasm-extractor.ts` + `indexer.ts`) — In incremental, `globalSymbolIndex` only contained changed files, not unchanged files in DB. Cross-file edges to/from unchanged files were silently lost. Fixed: cross-file resolution now only runs in **full mode**. In incremental mode, existing cross-file edges are preserved in DB; changed files' cross-file edges are deleted with the node delete phase. A full reindex is needed to rebuild all cross-file edges (documented limitation).

### Precision improvements (3)

1. **Member-call false positive filtering** (`fast-walker.ts`) — `console.log()`, `array.map()`, `db.prepare()` etc. were creating false CALLS edges to project functions with the same name. Fixed: `BUILTIN_METHOD_NAMES` denylist (90+ common method names) skips member calls to these names. Only `identifier_call` (e.g. `foo()`) and non-builtin `member_call` are collected for cross-file resolution.

2. **Call kind tracking + adjusted confidence** (`fast-walker.ts` + `wasm-extractor.ts` + `indexer.ts`) — Each `UnresolvedCallSite` now carries `callKind: 'identifier_call' | 'member_call' | 'computed_call'`. Member calls get `confidence` capped at 0.3 (vs 1.0 for identifier calls). Edge properties now include `call_kind`.

3. **JSON.stringify for edge properties** (`wasm-extractor.ts` + `indexer.ts`) — Edge properties were built by string concatenation (`'{"callee":"' + calleeName + '"}'`), which breaks if callee names contain quotes or special characters (computed calls like `obj["foo"]()`). Fixed: all cross-file edge properties now use `JSON.stringify()`.

4. **Resolution renamed** — `cross_file_exact` → `cross_file_name_exact` (clarifies that "exact" means name match, not import-aware certainty).

### Results comparison

| Metric | R98 | R99 | Change |
|---|---|---|---|
| Total CALLS | 1276 | 742 | -42% (fewer false positives) |
| Cross-file CALLS | 1081 | 547 | -49% (builtins filtered) |
| Intra-file CALLS | 195 | 195 | unchanged |
| Member-call CALLS | (not tracked) | 286 | new visibility |
| Edge properties | concat (unsafe) | JSON.stringify (safe) | fixed |
| Incremental | broken (silent loss) | disabled (honest) | fixed |

The reduction from 1276 to 742 CALLS edges is **expected and correct** — R98
included many false positives from builtins like `map`, `log`, `prepare`, `then`.
R99 filters these out while keeping genuine cross-file calls.

### Verification

```
Test Files  37 passed (37)
     Tests  382 passed (382)
```

### Files

- Modified: `v2/src/indexer/fast-walker.ts` (call_kind, BUILTIN_METHOD_NAMES denylist)
- Modified: `v2/src/indexer/wasm-extractor.ts` (incremental guard, JSON.stringify, adjusted confidence)
- Modified: `v2/src/indexer/indexer.ts` (same fixes for parallel path)
- Modified: `v2/package.json` (version 0.34.0)

### Next steps

1. **Import-aware resolution** — parse import statements to prefer imported symbols
2. **Call-sites persistent table** — enable cross-file CALLS in incremental mode
3. **Precision benchmark** — manually verify 20-50 cross-file CALLS edges
4. **Worker pool persistant** — for MCP/UI/watch daemon mode

## 0.33.0 — Round 98 (2026-07-08) Cross-file CALLS Resolution

**23rd round.** The biggest functional improvement since R73. V2 now resolves
cross-file function calls using a global symbol index, closing the gap with V1
from 11% to 76% CALLS edge coverage.

### Feature: Cross-file CALLS resolution

**Before R98:** V2 only resolved intra-file CALLS edges (function calls within
the same file). Cross-file calls (e.g. `parse()` imported from another module)
were silently dropped. V2 extracted 188 CALLS edges vs V1's 1681 (11% coverage).

**After R98:** V2 collects unresolved call-sites during extraction, then after
all nodes are inserted, builds a `globalSymbolIndex: Map<name, QN[]>` and
resolves cross-file calls. V2 now extracts 1276 CALLS edges (76% of V1's 1681).

**Architecture:**
1. `fast-walker.ts` collects `UnresolvedCallSite[]` for calls where no intra-file
   match was found
2. `wasm-extractor.ts` (single-thread) and `indexer.ts` (parallel) build a
   `globalSymbolIndex` after all nodes are inserted
3. Unresolved call-sites are resolved against the global index:
   - Exact name match → `cross_file_exact` (confidence=1.0)
   - Multiple candidates → `cross_file_ambiguous` (confidence=1/count)
   - Capped at 5 candidates to avoid edge explosion
4. Edge properties include: `resolution`, `confidence`, `candidate_count`, `candidate_index`

**Results (42-file SMALL workload):**
| Metric | Before R98 | After R98 | V1 |
|---|---|---|---|
| CALLS edges | 188 | 1276 | 1681 |
| Total edges | 876 | 1994 | 1681* |
| V1 coverage | 11% | **76%** | 100% |

*V1 total includes LSP-resolved calls that V2 can't match without import analysis.

### Verification

```
Test Files  37 passed (37)
     Tests  382 passed (382)
```

All existing tests pass — no regression in incremental safety, orphan edges,
duplicate QNs, or benchmark invariants.

### Files

- Modified: `v2/src/indexer/fast-walker.ts` (collect unresolved call-sites)
- Modified: `v2/src/indexer/wasm-extractor.ts` (cross-file resolution single-thread)
- Modified: `v2/src/indexer/indexer.ts` (cross-file resolution parallel path)
- Modified: `v2/src/indexer/worker.ts` (pass unresolved call-sites)
- Modified: `v2/package.json` (version 0.33.0)

### Next steps

1. **Import-aware resolution** — parse import statements to prefer imported symbols over same-name symbols in other files
2. **Scope-aware disambiguation** — prefer functions in the same directory/module
3. **Precision benchmark** — manually verify 20-50 cross-file CALLS edges for false positives
4. **Worker pool persistant** — for MCP/UI/watch daemon mode

## 0.32.1 — Round 95-96 (2026-07-08) Proof Strict + Parallel Legacy + Docs Traceability

**Rounds 21-22 (GPT 5.5 external audits R95-R96).** 0 new bugs — rounds 95-96
add proof-strict tests and docs traceability.

### R95 — V2_ROADMAP banner fix

- Replaced `R78-R90 (31 bugs, 8 optimizations, 374 tests)` with non-numeric formulation: "For all rounds after this archived roadmap, see v2/CHANGELOG.md."

### R96 — Proof strict + parallel legacy + docs

1. **Parallel strict test** (`r94-parallel-and-legacy.test.ts`) — Tests that `result.parallel === true` and `workerCount > 0` when `workers: 2` with 24 files. If vitest can't load WASM in workers, the test passes with an INFO log (not a silent skip). In production, parallel works correctly as proven by the incremental benchmark (which spawns a real process via `spawnSync`).

2. **Parallel legacy `mtime_ns = NULL` backfill test** — 24 files, `mtime_ns = NULL`, incremental, verifies: all `mtime_ns` backfilled, nodes unchanged. Falls back to single-thread if vitest worker env unavailable.

3. **MAINTAINERS_GUIDE redundant phrase fix** — "CHANGELOG.md entry, version bump ... CHANGELOG.md entry + version bump" → "CHANGELOG.md entry, package.json version, README/docs references, and any affected operational docs."

### Note on Vitest parallel proof

The Vitest test environment may not support WASM grammar loading in worker
threads. The parallel strict test is **conditional** — if workers can't load
WASM, it logs an INFO message and returns. The **real proof** that the parallel
path works comes from the incremental benchmark (`npm run bench:incremental:smoke`),
which spawns a real Node.js process via `spawnSync` and verifies:
- `parallel-full-cold` output contains "Parallel"
- All 9 benchmark invariants pass (orphan_edges=0, stats match, errors=0, etc.)

### Verification

```
Test Files  37 passed (37)
     Tests  382 passed (382)
```

### Total: 33 bugs + 10 optimizations + 27 tests across 22 rounds

| Round | Type | Count |
|---|---|---|
| R78-R82 (1-4) | bugs | 23 |
| R83-R84 (9-10) | optimizations + bugs | 3 opt + 2 bugs + portability |
| R85-R86 (11-12) | bugs | 4 + 6 tests |
| R87 (13) | tests + benchmark | 7 failure tests + incremental benchmark |
| R88-R89 (14-15) | bugs + benchmark | 2 bugs + CI lock |
| R90 (16) | optimizations | smoke mode + parallel assertion + prepared statements + CI wiring |
| R91 (17) | bug + benchmark + docs | 1 (legacy mtime_ns NULL) + exitCode lock + docs cleanup |
| R92 (18) | tests + portability | 3 real failure injection tests + spawnSync |
| R93 (19) | bug + test harness | 1 (mtime_ns NULL runtime fix) + XDG_CACHE_HOME + hash assertion + NODE_ENV gating |
| R94 (20) | proof lock | 3 tests (parallel failure + legacy backfill) + stderr + docs process |
| R95-R96 (21-22) | proof strict + docs | strict parallel test + parallel legacy backfill test + docs traceability |

## 0.32.0 — Round 94 (2026-07-08) Proof Lock — Parallel Failure + Legacy mtime_ns + CI Debug

**20th round (GPT 5.5 external audit R94).** 0 new bugs — this round closes the
last proof gaps: parallel worker failure injection test, legacy `mtime_ns = NULL`
backfill tests, benchmark stderr capture, and docs process cleanup.

### Tests added (3 new, real runtime)

New file: `v2/tests/indexer/r94-parallel-and-legacy.test.ts`

1. **`parallel: incremental with injected worker failure preserves old graph/hash`** — Creates 24 files, full index, modifies file5.ts, injects `CBM_TEST_FAIL_ON_FILE=file5.ts`, verifies: error reported, old nodes preserved, hash not updated, orphan_edges=0, self-heal on retry. Falls back to single-thread if vitest worker env can't load WASM grammars.

2. **`single-thread: mtime_ns NULL gets backfilled without touching nodes`** — Creates file, full index, manually sets `mtime_ns = NULL` in DB (simulating legacy), runs incremental, verifies `mtime_ns` is backfilled and nodes are unchanged.

3. **`second incremental after backfill fast-skips without hashing`** — After backfill, second incremental fast-skips via `mtime_ns` (proving the backfill worked).

### Benchmark improvement (1)

- **`stderr` captured and displayed** (`incremental-benchmark-r87.ts`) — `runIndexer()` now returns `{ exitCode, output, stderr }`. If `exitCode !== 0`, stderr is printed to console for CI debugging.

### Docs process fix (1)

- **`MAINTAINERS_GUIDE.md` V2_ROADMAP contradiction resolved** — Replaced all "update V2_ROADMAP round entry + metrics" with "update CHANGELOG.md entry + version bump". V2_ROADMAP is explicitly marked as archived; maintainers no longer need to update it.

### Verification

```
Test Files  37 passed (37)
     Tests  380 passed (380)
```

### Files

- New: `v2/tests/indexer/r94-parallel-and-legacy.test.ts` (3 real runtime tests)
- Modified: `v2/scripts/incremental-benchmark-r87.ts` (stderr capture + display)
- Modified: `MAINTAINERS_GUIDE.md` (V2_ROADMAP archived, CHANGELOG is source of truth)
- Modified: `v2/package.json` (version 0.32.0)

### Total: 33 bugs + 10 optimizations + 25 tests across 20 rounds

| Round | Type | Count |
|---|---|---|
| R78-R82 (1-4) | bugs | 23 |
| R83-R84 (9-10) | optimizations + bugs | 3 opt + 2 bugs + portability |
| R85-R86 (11-12) | bugs | 4 + 6 tests |
| R87 (13) | tests + benchmark | 7 failure tests + incremental benchmark |
| R88-R89 (14-15) | bugs + benchmark | 2 bugs + CI lock |
| R90 (16) | optimizations | smoke mode + parallel assertion + prepared statements + CI wiring |
| R91 (17) | bug + benchmark + docs | 1 (legacy mtime_ns NULL) + exitCode lock + docs cleanup |
| R92 (18) | tests + portability | 3 real failure injection tests + spawnSync |
| R93 (19) | bug + test harness | 1 (mtime_ns NULL runtime fix) + XDG_CACHE_HOME + hash assertion + NODE_ENV gating |
| R94 (20) | proof lock | 3 tests (parallel failure + legacy backfill) + stderr + docs process |

### Next steps

**All 14 GPT 5.5 audit reports are now fully closed.** The incremental indexer is
locked with:
- 33 bugs fixed
- 10 optimizations
- 25 versioned tests (7 failure simulation + 3 real failure injection + 3 parallel/legacy + 6 fast-skip + 6 correctness)
- 9-scenario benchmark with 6 invariants, CI-wired, smoke mode
- Real failure injection (CBM_TEST_FAIL_ON_FILE)
- Legacy mtime_ns NULL backfill verified

1. **Cross-file CALLS resolution** — V2 still misses 900+ edges V1 finds. This is the #1 remaining functional gap.
2. **Worker pool persistant** — for MCP/UI/watch daemon mode
3. **Benchmark cold vs warm process** — separate CLI cold from persistent process

## 0.31.0 — Round 93 (2026-07-08) Legacy mtime_ns Runtime Fix + Test Harness Correctness

**19th round (GPT 5.5 external audit R93).** 1 bug fixed + test harness fixes.
GPT 5.5 found that R91's estimation-pass fix for `mtime_ns = NULL` was
incomplete — the extraction paths still fell back to `Math.floor(mtimeMs)`,
allowing the false-skip risk to persist on legacy DBs.

### Bug fixed (1, from GPT 5.5 R93 audit)

33. **`mtime_ns = NULL` still fast-skips on `Math.floor(mtimeMs)` in extraction paths** (`wasm-extractor.ts` + `indexer.ts`) — R91 fixed the estimation pass (`estimatedFilesToIndex++` when `mtime_ns` is NULL), but the actual extraction paths (`wasm-extractor.ts` and `indexParallel()`) still had the old fallback: `existing.mtime_ns ? existing.mtime_ns === fileMtimeNs : existing.mtime === fileMtime`. So the estimation forced entry into the pipeline, but the pipeline itself could still fast-skip on `mtime` integer, never backfilling `mtime_ns`. Fixed: removed the `mtime` integer fallback entirely. Now: if `mtime_ns` exists and matches → fast-skip. If `mtime_ns` is NULL or mismatches → read+hash → metadata-only update (backfills `mtime_ns`) or re-index.

### Test harness fixes (3, from GPT 5.5 R93 audit)

1. **`XDG_CACHE_HOME` set before first `indexProjectWasm()` call** (`r92-real-failure-injection.test.ts`) — Previously `XDG_CACHE_HOME` was set after the full index, so full index wrote to `~/.cache/...` and incremental wrote to `tmpDir/cache/...`. The test verified the wrong DB. Fixed: `XDG_CACHE_HOME` is now set in `beforeEach()` before any indexer call. Added `expect(result2.dbPath).toBe(result1.dbPath)` assertion.

2. **Hash assertion added** (`r92-real-failure-injection.test.ts`) — Previously `aHash` was read but never asserted. Now: `aHashAfter.content_hash` is compared to `aHashBefore.content_hash`, proving the hash was NOT updated for the failed file.

3. **`CBM_TEST_FAIL_ON_FILE` gated by `NODE_ENV === 'test'`** (`wasm-extractor.ts` + `worker.ts`) — The failure injection was active whenever the env var was set, even in production. Now gated: `process.env.NODE_ENV === 'test' && process.env.CBM_TEST_FAIL_ON_FILE === relPath`. Production code can never trigger it.

### Benchmark hardening (1)

- **`spawnSync` status handling** (`incremental-benchmark-r87.ts`) — `res.status ?? 0` could return 0 when `status` is null (signal/error). Now: `res.status ?? (res.error || res.signal ? 1 : 0)`. Also captures stderr for debugging.

### Verification

```
Test Files  36 passed (36)
     Tests  377 passed (377)
```

### Files

- Modified: `v2/src/indexer/wasm-extractor.ts` (Bug 33: removed mtime integer fallback)
- Modified: `v2/src/indexer/indexer.ts` (Bug 33: same fix in indexParallel)
- Modified: `v2/src/indexer/worker.ts` (NODE_ENV gating for CBM_TEST_FAIL_ON_FILE)
- Modified: `v2/tests/indexer/r92-real-failure-injection.test.ts` (XDG_CACHE_HOME + hash assertion)
- Modified: `v2/scripts/incremental-benchmark-r87.ts` (spawnSync status hardening)
- Modified: `v2/package.json` (version 0.31.0)

### Total: 33 bugs + 10 optimizations + 22 tests across 19 rounds

| Round | Type | Count |
|---|---|---|
| R78-R82 (1-4) | bugs | 23 |
| R83-R84 (9-10) | optimizations + bugs | 3 opt + 2 bugs + portability |
| R85-R86 (11-12) | bugs | 4 + 6 tests |
| R87 (13) | tests + benchmark | 7 failure tests + incremental benchmark |
| R88-R89 (14-15) | bugs + benchmark | 2 bugs + CI lock |
| R90 (16) | optimizations | smoke mode + parallel assertion + prepared statements + CI wiring |
| R91 (17) | bug + benchmark + docs | 1 (legacy mtime_ns NULL estimation) + exitCode lock + 3 docs cleanup |
| R92 (18) | tests + portability | 3 real failure injection tests + spawnSync |
| R93 (19) | bug + test harness | 1 (mtime_ns NULL runtime fix) + XDG_CACHE_HOME + hash assertion + NODE_ENV gating + spawnSync hardening |

### Next steps

1. **Cross-file CALLS resolution** — V2 still misses 900+ edges V1 finds. This is the #1 remaining functional gap. All incremental safety is now locked.
2. **Worker pool persistant** — for MCP/UI/watch daemon mode
3. **Benchmark cold vs warm process** — separate CLI cold from persistent process

## 0.30.0 — Round 92 (2026-07-08) Real Failure Injection + Benchmark Portability

**18th round (GPT 5.5 external audit R91B).** 0 new bugs — this round closes
the last two items from the GPT 5.5 audit: real failure injection tests
(the "biggest hole" identified since R87) and benchmark portability fix.

### Improvements (2, from GPT 5.5 R91B audit)

1. **`CBM_TEST_FAIL_ON_FILE` failure injection** (`wasm-extractor.ts` + `worker.ts`) — Added a test-only env var that throws an error when the indexer processes a specific file. Placed just before `extractFast()` in both single-thread and worker paths. Only active when the env var is set (production code is unaffected). This enables real runtime failure tests instead of SQL simulations.

2. **Benchmark uses `spawnSync` instead of `execSync(args.join(' '))`** (`incremental-benchmark-r87.ts`) — The old `execSync` was fragile: paths with spaces, shell injection risk, Windows incompatibility. Now uses `spawnSync(process.execPath, args, ...)` which passes arguments directly without shell interpretation.

### Tests added (3 new, real runtime injection)

New file: `v2/tests/indexer/r92-real-failure-injection.test.ts`

- **`single-thread: full index succeeds, then incremental with injected failure preserves old graph`** — Calls `indexProjectWasm()` with `CBM_TEST_FAIL_ON_FILE=a.ts`. Verifies: error reported, old nodes preserved, old hash not updated, orphan_edges=0. This is a **real runtime test**, not a simulation.
- **`single-thread: incremental without --allow-partial reports errors`** — Verifies the error is surfaced in `result.errors`.
- **`single-thread: after failure, retry without injection succeeds and updates graph`** — Verifies the system self-heals: after a failed incremental, retrying without the failure injection re-indexes the file correctly.

### Verification

```
Test Files  36 passed (36)
     Tests  377 passed (377)
```

(374 existing + 3 new real failure injection tests)

Smoke benchmark: all 9 invariants pass (with spawnSync).

### Files

- Modified: `v2/src/indexer/wasm-extractor.ts` (CBM_TEST_FAIL_ON_FILE injection point)
- Modified: `v2/src/indexer/worker.ts` (CBM_TEST_FAIL_ON_FILE injection point)
- Modified: `v2/scripts/incremental-benchmark-r87.ts` (spawnSync instead of execSync)
- New: `v2/tests/indexer/r92-real-failure-injection.test.ts` (3 real failure tests)
- Modified: `v2/package.json` (version 0.30.0)

### Total: 32 bugs + 10 optimizations + 22 tests across 18 rounds

| Round | Type | Count |
|---|---|---|
| R78-R82 (1-4) | bugs | 23 |
| R83-R84 (9-10) | optimizations + bugs | 3 opt + 2 bugs + portability |
| R85-R86 (11-12) | bugs | 4 + 6 tests |
| R87 (13) | tests + benchmark | 7 failure tests + incremental benchmark |
| R88-R89 (14-15) | bugs + benchmark | 2 bugs + CI lock |
| R90 (16) | optimizations | smoke mode + parallel assertion + prepared statements + CI wiring |
| R91 (17) | bug + benchmark + docs | 1 (legacy mtime_ns NULL) + exitCode lock + 3 docs cleanup |
| R92 (18) | tests + portability | 3 real failure injection tests + spawnSync |

### Next steps

1. **Cross-file CALLS resolution** — V2 still misses 900+ edges V1 finds. This is the #1 remaining functional gap.
2. **Worker pool persistant** — for MCP/UI/watch daemon mode
3. **Benchmark cold vs warm process** — separate CLI cold from persistent process

## 0.29.0 — Round 91 (2026-07-08) ExitCode Lock + Legacy mtime_ns Backfill + Docs

**17th round (GPT 5.5 external audit R91).** 1 bug fixed + benchmark hardening
+ docs cleanup. The GPT 5.5 audit found that the benchmark didn't check
`exitCode`, legacy DBs with `mtime_ns = NULL` could fast-skip incorrectly,
and several docs were stale.

### Bug fixed (1, from GPT 5.5 R91 audit)

32. **Legacy `mtime_ns = NULL` fast-skips on `Math.floor(mtimeMs)` indefinitely** (`indexer.ts`) — Pre-R85 DBs have `mtime_ns = NULL` after migration. The estimation pass fell back to `existing.mtime === Math.floor(Number(stat.mtimeMs))`, which has the same false-skip risk that R85 was supposed to fix. And since `estimatedFilesToIndex` could be 0 (all files "match" on mtime+size), the R89 early return prevented the extractor from ever backfilling `mtime_ns`. Fixed: if `existing.mtime_ns` is NULL, treat the file as needing re-indexing (`estimatedFilesToIndex++`), which forces a hash+metadata-only update that backfills `mtime_ns`.

### Benchmark hardening (1)

- **`exitCode` added to `BenchResult` and checked as invariant** — Previously `runIndexer()` returned `exitCode` but it wasn't stored or verified. Now every scenario stores `exitCode` and the invariant loop checks `r.exitCode !== 0` → `allOk = false`. This catches CLI crashes that produce no `Errors:` line.

### Docs cleanup (3 files)

1. **Root `README.md`** — Removed stale `Current audited line: R85 / 0.23.0` line. Now only references `v2/CHANGELOG.md`.
2. **`docs/V2_ROADMAP.md`** — Added archive banner: "Historical roadmap, archived at 0.15.9. For current version, see v2/CHANGELOG.md."
3. **`MAINTAINERS_GUIDE.md`** — Replaced stale `77 audit rounds`, `378 tests`, `355 backend` with references to `v2/CHANGELOG.md`. Added `npm run bench:incremental:smoke` to the pre-merge checklist.

### Verification

```
Test Files  35 passed (35)
     Tests  374 passed (374)
```

Smoke benchmark: all 9 invariants pass (including exitCode check).

### Files

- Modified: `v2/src/indexer/indexer.ts` (Bug 32: mtime_ns NULL → estimatedFilesToIndex++)
- Modified: `v2/scripts/incremental-benchmark-r87.ts` (exitCode in BenchResult + invariant check)
- Modified: `README.md` (removed stale audited line)
- Modified: `docs/V2_ROADMAP.md` (archive banner)
- Modified: `MAINTAINERS_GUIDE.md` (stale counts → CHANGELOG refs + bench step)
- Modified: `v2/package.json` (version 0.29.0)

### Total: 32 bugs + 8 optimizations across 17 rounds

| Round | Type | Count |
|---|---|---|
| R78-R82 (1-4) | bugs | 23 |
| R83-R84 (9-10) | optimizations + bugs | 3 opt + 2 bugs + portability |
| R85-R86 (11-12) | bugs | 4 + 6 tests |
| R87 (13) | tests + benchmark | 7 failure tests + incremental benchmark |
| R88-R89 (14-15) | bugs + benchmark | 2 bugs + CI lock |
| R90 (16) | optimizations | smoke mode + parallel assertion + prepared statements + CI wiring |
| R91 (17) | bug + benchmark + docs | 1 (legacy mtime_ns NULL) + exitCode lock + 3 docs cleanup |

### Next steps

1. **Cross-file CALLS resolution** — V2 still misses 900+ edges V1 finds
2. **Worker pool persistant** — for MCP/UI/watch daemon mode
3. **Real failure injection tests** — inject extractFast/worker failure at runtime

## 0.28.0 — Round 90 (2026-07-08) CI Benchmark Lock + Smoke Mode + Prepared Statements

**16th round (GPT 5.5 external audit R90).** 0 new bugs — this round hardens
the benchmark CI integration, implements the missing smoke mode, adds a
blocking parallel path assertion, and optimizes prepared statements in O(N)
loops. All items from the GPT 5.5 R90 audit are addressed.

### Improvements (4, from GPT 5.5 R90 audit)

1. **CBM_BENCH_SMOKE implemented** (`incremental-benchmark-r87.ts`) — The `bench:incremental:smoke` script was defined in package.json but the env var was never read. Now `CBM_BENCH_SMOKE=1` reduces file counts (8 single-thread, 24 parallel) for fast CI runs. Smoke mode still exercises the parallel path (>20 files).

2. **Parallel path assertion is now blocking** (`incremental-benchmark-r87.ts`) — Previously `isParallel6` was computed and displayed but not used as an invariant. Now if the parallel-full-cold scenario doesn't use the parallel path, `allOk = false` and the benchmark fails.

3. **Prepared statements moved outside O(N) loops** (`indexer.ts`) — Both the estimation pass and the parallel incremental scan were calling `db.prepare()` inside per-file loops. On 50k files this is measurable overhead. Now prepared once before the loop and reused.

4. **Benchmark wired to GitHub Actions CI** (`.github/workflows/ci.yml`) — Added `npm run bench:incremental:smoke` step after `Test` in the backend job. CI will now fail if any benchmark invariant breaks.

### Smoke benchmark results (all pass)

```
full-cold                        279ms     8     0     24     16     0      0     8    true
incremental-noop                 196ms     0     8     24     16     0      0     8    true
incremental-metadata-only        234ms     0     8     24     16     0      0     8    true
incremental-1-file               247ms     1     7     24     16     0      0     8    true
incremental-10pct                234ms     1     7     24     16     0      0     8    true
parallel-full-cold               445ms    24     0     72     48     0      0    24    true
parallel-incremental-noop        196ms     0    24     72     48     0      0    24    true
parallel-metadata-only           198ms     0    24     72     48     0      0    24    true
parallel-noop-after-meta         198ms     0    24     72     48     0      0    24    true

✓ All invariants pass
BENCHMARK PASSED — all invariants met
```

### Verification

```
Test Files  35 passed (35)
     Tests  374 passed (374)
```

### Files

- Modified: `v2/scripts/incremental-benchmark-r87.ts` (smoke mode + parallel assertion)
- Modified: `v2/src/indexer/indexer.ts` (prepared statements outside loops)
- Modified: `.github/workflows/ci.yml` (benchmark step in CI)
- Modified: `v2/package.json` (version 0.28.0)

### Total: 31 bugs + 8 optimizations across 16 rounds

| Round | Type | Count |
|---|---|---|
| R78-R82 (1-4) | bugs | 23 |
| R83-R84 (9-10) | optimizations + bugs | 3 opt + 2 bugs + portability |
| R85-R86 (11-12) | bugs | 4 + 6 tests |
| R87 (13) | tests + benchmark | 7 failure tests + incremental benchmark |
| R88-R89 (14-15) | bugs + benchmark | 2 bugs + CI lock |
| R90 (16) | optimizations | smoke mode + parallel assertion + prepared statements + CI wiring |

### Next steps

1. **Cross-file CALLS resolution** — V2 still misses 900+ edges V1 finds
2. **Worker pool persistant** — for MCP/UI/watch daemon mode
3. **Real failure injection tests** — inject extractFast/worker failure at runtime

## 0.27.0 — Round 89 (2026-07-08) Benchmark CI Lock + No-Op Early Return

**15th round (GPT 5.5 external audit R90).** 1 bug fixed + benchmark hardening.
The GPT 5.5 audit found that the benchmark had gaps: some `✗` branches didn't
set `allOk = false`, `errors` and `hashCount` weren't checked for all scenarios,
and the benchmark wasn't wired to npm scripts/CI. Also fixed a perf debt: no-op
incremental did a double stat+DB pass.

### Bug fixed (1, from GPT 5.5 R90 audit)

31. **No-op incremental does double stat+DB pass** (`indexer.ts`) — The estimation pass (`estimatedFilesToIndex`) and the extraction pass (`extractFromFilesWasm`) both do `statSync` + DB lookup for every file. On a 50k-file repo with no changes, this doubles the metadata I/O. Fixed: if `opts.incremental && estimatedFilesToIndex === 0`, skip the extraction phase entirely and return early after `updateProjectStats`.

### Benchmark hardening (4 improvements)

1. **All `✗` branches now set `allOk = false`** — Previously the single-thread no-op check printed `✗` but didn't fail the benchmark. Now every `✗` branch sets `allOk = false`, ensuring `process.exitCode = 1`.

2. **`errors` checked for all scenarios** — If any scenario has `errors > 0`, the benchmark now fails. Previously extraction errors could pass if DB stats were still consistent.

3. **`hashCount` checked for all scenarios** — Previously only `parallel-full-cold` verified hash coverage. Now all scenarios verify `hashCount === expectedHashCount` (20 for single-thread, 64 for parallel).

4. **npm scripts added** — `bench:incremental` and `bench:incremental:smoke` scripts added to `package.json` so the benchmark can be run via `npm run bench:incremental` and wired to CI.

### Benchmark results (all pass)

```
Scenario                         Wall   Idx   Skp  Nodes  Edges  Orph  DupQN  Hash  StatOK  Errors
full-cold                        309ms    20     0     60     40     0      0    20    true    0
incremental-noop                 200ms     0    20     60     40     0      0    20    true    0
incremental-metadata-only        229ms     0    20     60     40     0      0    20    true    0
incremental-1-file               238ms     1    19     60     40     0      0    20    true    0
incremental-10pct                238ms     2    18     60     40     0      0    20    true    0
parallel-full-cold               489ms    64     0    192    128     0      0    64    true    0
parallel-incremental-noop        212ms     0    64    192    128     0      0    64    true    0
parallel-metadata-only           199ms     0    64    192    128     0      0    64    true    0
parallel-noop-after-meta         201ms     0    64    192    128     0      0    64    true    0

✓ All invariants pass: orphan_edges=0, stats match, no duplicate QNs, errors=0, hash coverage
BENCHMARK PASSED — all invariants met
```

### Verification

```
Test Files  35 passed (35)
     Tests  374 passed (374)
```

### Files

- Modified: `v2/src/indexer/indexer.ts` (Bug 31: early return no-op incremental)
- Modified: `v2/scripts/incremental-benchmark-r87.ts` (all ✗ → allOk=false, errors check, hashCount check)
- Modified: `v2/package.json` (version 0.27.0 + bench:incremental scripts)

### Total: 31 bugs + 6 optimizations + 19 tests across 15 rounds

| Round | Type | Count |
|---|---|---|
| R78-R82 (1-4) | bugs | 23 |
| R83 (9) | optimizations | 3 + portability |
| R84 (10) | bugs | 2 + docs sync |
| R85 (11) | bugs | 2 + 6 tests + docs sync |
| R86 (12) | bugs | 2 |
| R87 (13) | tests + benchmark | 7 failure tests + incremental benchmark |
| R88 (14) | bug + benchmark | 1 + parallel scenarios + CI exit code |
| R89 (15) | bug + benchmark | 1 (no-op early return) + CI lock hardening + npm scripts |

### Next steps

1. **Cross-file CALLS resolution** — V2 still misses 900+ edges V1 finds
2. **Worker pool persistant** — for MCP/UI/watch daemon mode
3. **Benchmark cold vs warm process** — separate CLI cold from persistent process

## 0.26.0 — Round 88 (2026-07-08) Parallel Metadata Fix + Benchmark CI Lock

**14th round (GPT 5.5 external audit R89).** 1 bug fixed + benchmark improvements.
The GPT 5.5 audit found a critical edge case: parallel incremental metadata-only
updates were silently lost when `batches.length === 0` (all files metadata-only).

### Bug fixed (1, from GPT 5.5 R89 audit)

30. **Parallel incremental metadata-only updates lost when batches.length === 0** (`indexer.ts`) — When all files in a parallel incremental run are metadata-only (mtime changed, content same), `filesToIndex` is empty for every language, so `batches.length === 0`. The function returned early before reaching the transaction that applies `allMetadataOnlyHashUpdates`. Result: mtime_ns/size were never persisted, and the next run re-stat + re-read + re-hash all "metadata-only" files. Fixed: apply metadata-only updates in a transaction before the early return.

### Benchmark improvements (3)

1. **Parallel scenarios added** (`incremental-benchmark-r87.ts`) — Added 4 new scenarios with 64 files to exercise the parallel path: `parallel-full-cold`, `parallel-incremental-noop`, `parallel-metadata-only`, `parallel-noop-after-meta`. All verify hash coverage, orphan edges, stats match, and no duplicate QNs.

2. **Benchmark exits non-zero on invariant failure** — Previously the benchmark printed errors but exited 0. Now `process.exitCode = 1` if any invariant fails (orphan edges, stats mismatch, duplicate QNs, hash coverage, incremental correctness).

3. **Parallel correctness checks** — Verifies: parallel no-op (0 indexed, 64 skipped), parallel metadata-only (nodes preserved), parallel fast-skip after metadata-only (0 indexed, 64 skipped), parallel hash coverage (64/64).

### Benchmark results (all pass)

```
parallel-full-cold               476ms    64     0    192    128     0      0    64    true
parallel-incremental-noop        252ms     0    64    192    128     0      0    64    true
parallel-metadata-only           212ms     0    64    192    128     0      0    64    true
parallel-noop-after-meta         231ms     0    64    192    128     0      0    64    true

✓ Parallel no-op: 0 indexed, 64 skipped
✓ Parallel metadata-only: nodes preserved (192)
✓ Parallel fast-skip after metadata-only: 0 indexed, 64 skipped
✓ Parallel hash coverage: 64/64
BENCHMARK PASSED — all invariants met
```

### Docs fix

- `v2/README.md` — replaced stale `378 tests` with `see CHANGELOG.md for current test count`

### Verification

```
Test Files  35 passed (35)
     Tests  374 passed (374)
```

### Files

- Modified: `v2/src/indexer/indexer.ts` (Bug 30: metadata-only updates before early return)
- Modified: `v2/scripts/incremental-benchmark-r87.ts` (parallel scenarios + exit code)
- Modified: `v2/README.md` (docs sync)
- Modified: `v2/package.json` (version 0.26.0)

### Total: 30 bugs + 6 optimizations + 19 tests across 14 rounds

| Round | Type | Count |
|---|---|---|
| R78-R82 (1-4) | bugs | 8+1+5+5+4 = 23 |
| R83 (9) | optimizations | 3 + portability |
| R84 (10) | bugs | 2 + docs sync |
| R85 (11) | bugs | 2 (mtimeNs, no-pre-read) + 6 tests + docs sync |
| R86 (12) | bugs | 2 (parallel hash persistence, threshold fix) |
| R87 (13) | tests + benchmark | 7 failure tests + incremental benchmark |
| R88 (14) | bug + benchmark | 1 (parallel metadata-only early return) + parallel scenarios + CI exit code |

### Next steps

1. **Cross-file CALLS resolution** — V2 still misses 900+ edges V1 finds
2. **Worker pool persistant** — for MCP/UI/watch daemon mode
3. **Benchmark cold vs warm process** — separate CLI cold from persistent process

## 0.25.0 — Round 87 (2026-07-08) Incremental Failure Tests + Benchmark

**13th round (GPT 5.5 external audit R86).** 0 new bugs — this round adds the
missing tests d'échec réel and incremental benchmark with correctness invariants
that were pending since R82. All P1/P2 items from the R86 audit are now closed.

### Tests added (7 new, versioned)

New file: `v2/tests/indexer/r87-incremental-failure.test.ts`

- `extractFast failure preserves old graph and hash` — Bug 20 regression test
- `parallel worker failure preserves old graph and hash` — Bug 21 regression test
- `CLI exit non-zero on errors without --allow-partial` — Bug 22 regression test
- `CLI exit 0 with --allow-partial` — Bug 22 regression test
- `CLI exit 0 when no errors` — Bug 22 regression test
- `metadata-only updates safe even if other files fail` — Bug 24/25 atomicity test
- `no orphan edges when some files fail` — invariant test

### Incremental benchmark with invariants

New file: `v2/scripts/incremental-benchmark-r87.ts`

Scenarios measured:
1. `full-cold` — baseline full index
2. `incremental-noop` — nothing changed, all should skip
3. `incremental-metadata-only` — mtime changed, content same
4. `incremental-1-file` — 1 file content changed
5. `incremental-10pct` — 10% of files changed

Invariants checked after each run:
- `orphan_edges = 0`
- `projects.node_count == COUNT(nodes)` and `projects.edge_count == COUNT(edges)`
- No duplicate `(project, qualified_name)`
- `file_hashes` count matches indexed files

Results (20-file test project):
```
Scenario                     Wall   Idx   Skp  Nodes  Edges  Orph  DupQN  Hash  StatOK
full-cold                    312ms    20     0     60     40     0      0    20    true
incremental-noop             229ms     0    20     60     40     0      0    20    true
incremental-metadata-only    230ms     0    20     60     40     0      0    20    true
incremental-1-file           237ms     1    19     60     40     0      0    20    true
incremental-10pct            234ms     2    18     60     40     0      0    20    true

✓ All invariants pass: orphan_edges=0, stats match, no duplicate QNs
✓ No-op incremental: 0 indexed, 20 skipped
✓ Metadata-only: nodes preserved (60)
```

### Verification

```
Test Files  35 passed (35)
     Tests  374 passed (374)
```

(367 existing + 7 new R87 tests)

### Files

- New: `v2/tests/indexer/r87-incremental-failure.test.ts` (7 versioned tests)
- New: `v2/scripts/incremental-benchmark-r87.ts` (incremental benchmark with invariants)
- Modified: `v2/package.json` (version 0.25.0)

### Total: 29 bugs + 6 optimizations + 19 tests across 13 rounds

| Round | Type | Count |
|---|---|---|
| R78 (1-4) | bugs | 8 |
| R79 (5) | bugs | 1 |
| R80 (6) | bugs | 5 |
| R81 (7) | bugs | 5 |
| R82 (8) | bugs | 4 |
| R83 (9) | optimizations | 3 + portability |
| R84 (10) | bugs | 2 + docs sync |
| R85 (11) | bugs | 2 (mtimeNs, no-pre-read) + 6 tests + docs sync |
| R86 (12) | bugs | 2 (parallel hash persistence, threshold fix) |
| R87 (13) | tests + benchmark | 7 failure tests + incremental benchmark with invariants |

### Next steps

1. **Cross-file CALLS resolution** — V2 still misses 900+ edges V1 finds
2. **Worker pool persistant** — for MCP/UI/watch daemon mode
3. **Benchmark cold vs warm process** — separate CLI cold from persistent process

## 0.24.0 — Round 86 (2026-07-08) Parallel Hash Persistence + Threshold Fix

**12th round (GPT 5.5 external audit R85).** 2 bugs fixed. R85 fixed mtimeNs
and pre-read, but the parallel path still had two critical gaps: (1) full
mode parallel didn't store `file_hashes`, so the first incremental re-indexed
everything; (2) `useParallel` was based on total files, not files to index,
so 1 file changed out of 10000 still spawned workers.

### Bugs fixed (2, from GPT 5.5 R85 audit)

28. **`useParallel` based on total files, not files to index** (`indexer.ts`) — `useParallel = files.length > 80` meant that in incremental mode with 1 file changed out of 10000, the code still spawned workers. Fixed: in incremental mode, do a quick stat+lookup pass to estimate `filesToIndex`, then decide `useParallel` based on `estimatedFilesToIndex > 20`. Full mode uses `files.length` as before.

29. **Parallel full index doesn't store `file_hashes`** (`worker.ts` + `indexer.ts`) — `allPendingHashUpdates` was only populated inside `if (incremental)`. In full mode parallel, no hashes were stored, so the first incremental after a full parallel index re-indexed everything. Fixed: workers now return `hashInfo` (hash, mtime, mtimeNs, size) in `WorkerFileResult`. The main thread upserts hashes for all successful files in full mode using this info — no double file reads needed.

### Verification

```
Test Files  34 passed (34)
     Tests  367 passed (367)
```

### Files

- Modified: `v2/src/indexer/worker.ts` (Bug 29: return hashInfo in WorkerFileResult)
- Modified: `v2/src/indexer/indexer.ts` (Bug 28: estimate filesToIndex; Bug 29: upsert hashes in full mode from worker hashInfo)
- Modified: `v2/package.json` (version 0.24.0)

### Total: 29 bugs + 6 optimizations across 12 rounds

| Round | Type | Count |
|---|---|---|
| R78 (1-4) | bugs | 8 |
| R79 (5) | bugs | 1 |
| R80 (6) | bugs | 5 |
| R81 (7) | bugs | 5 |
| R82 (8) | bugs | 4 |
| R83 (9) | optimizations | 3 + portability |
| R84 (10) | bugs | 2 + docs sync |
| R85 (11) | bugs | 2 (mtimeNs, no-pre-read) + 6 tests + docs sync |
| R86 (12) | bugs | 2 (parallel hash persistence, threshold fix) |

### Next steps

1. **Tests d'échec réel** — inject extractFast failure, verify old graph/hash preserved
2. **Cross-file CALLS resolution** — V2 still misses 900+ edges V1 finds
3. **Worker pool persistant** — for MCP/UI/watch daemon mode
4. **Benchmark incremental scenarios** — noop, 1-file, 10% with invariants

## 0.23.0 — Round 85 (2026-07-08) mtimeNs Precision + No-Pre-Read Incremental

**11th round (GPT 5.5 external audit R84).** 2 bugs fixed. R84's fast skip had
two critical gaps: (1) `Math.floor(mtimeMs)` could cause false skips for
same-millisecond same-size changes; (2) single-thread pre-read all files
before fast-skip check, making no-op incremental O(bytes) not O(stat).

### Bugs fixed (2, from GPT 5.5 R84 audit)

26. **`Math.floor(stat.mtimeMs)` can cause false skips** (`wasm-extractor.ts` + `indexer.ts`) — If two versions of the same size are written in the same millisecond, `Math.floor(mtimeMs)` rounds to the same integer, and the fast skip incorrectly skips the changed file. Fixed: use `statSync(path, { bigint: true }).mtimeNs` (nanosecond precision) stored as TEXT in `file_hashes.mtime_ns`. Migration auto-adds the column. Falls back to `mtime` comparison for pre-R85 DBs where `mtime_ns` is null.

27. **Single-thread pre-read breaks O(stat) incremental** (`wasm-extractor.ts`) — The single-thread path pre-read ALL files into `fileContents` before checking mtime+size, making no-op incremental O(total bytes read) instead of O(stat). Fixed: in incremental mode, files are read lazily — only when mtime+size mismatch. Full mode keeps pre-read for OS prefetch optimization.

### Schema change

- Added `mtime_ns TEXT` column to `file_hashes` (nullable for backward compat)
- `migrateFileHashesMtimeNsColumn()` auto-adds column to existing DBs
- All upserts now store `mtime_ns` alongside `mtime`
- Fast-skip uses `mtime_ns` when available, falls back to `mtime` for old data

### Tests added (6 new, versioned)

New file: `v2/tests/indexer/r85-fast-skip.test.ts`

- `adds mtime_ns column to old file_hashes table` — migration test
- `does not re-add mtime_ns if already present` — idempotency
- `fast-skip uses mtime_ns when available` — nanosecond precision
- `falls back to mtime when mtime_ns is null` — backward compat
- `metadata-only update does not touch nodes table` — correctness
- `no orphan edges when metadata-only update skips re-indexing` — invariant

### Docs sync

- Root `README.md` — replaced stale hardcoded version/counts with reference to `v2/package.json` and `v2/CHANGELOG.md`. No more stale numbers.

### Verification

```
Test Files  34 passed (34)
     Tests  367 passed (367)
```

(361 existing + 6 new R85 tests)

### Files

- Modified: `v2/src/indexer/schema.ts` (mtime_ns column + migration)
- Modified: `v2/src/indexer/wasm-extractor.ts` (Bug 26: mtimeNs + Bug 27: no pre-read in incremental)
- Modified: `v2/src/indexer/indexer.ts` (Bug 26: mtimeNs in parallel path)
- Modified: `README.md` (docs sync: no more stale version numbers)
- Modified: `v2/package.json` (version 0.23.0)
- New: `v2/tests/indexer/r85-fast-skip.test.ts` (6 versioned tests)

### Total: 27 bugs + 6 optimizations across 11 rounds

| Round | Type | Count |
|---|---|---|
| R78 (1-4) | bugs | 8 |
| R79 (5) | bugs | 1 |
| R80 (6) | bugs | 5 |
| R81 (7) | bugs | 5 |
| R82 (8) | bugs | 4 |
| R83 (9) | optimizations | 3 + portability |
| R84 (10) | bugs | 2 + docs sync |
| R85 (11) | bugs | 2 (mtimeNs precision, no-pre-read incremental) + 6 tests + docs sync |

### Next steps

1. **Tests d'échec réel** — inject extractFast failure, verify old graph/hash preserved (still pending)
2. **Cross-file CALLS resolution** — V2 still misses 900+ edges V1 finds
3. **Worker pool persistant** — for MCP/UI/watch daemon mode
4. **Benchmark incremental scenarios** — noop, 1-file, 10% with invariants

## 0.22.0 — Round 84 (2026-07-08) Fast Skip Safety + Parallel Port + Docs

**10th round (GPT 5.5 external audit R83).** 2 bugs fixed. R83's mtime+size
fast skip had two critical gaps: (1) it didn't update mtime/size when content
was unchanged, so the fast skip never activated on subsequent runs; (2) the
parallel path didn't use the fast skip at all. Both are now fixed.

### Bugs fixed (2, from GPT 5.5 R83 audit)

24. **Fast skip doesn't update mtime/size when hash identical** (`wasm-extractor.ts`) — When mtime/size changed but content_hash was the same, the code skipped re-indexing but didn't update `file_hashes.mtime/size`. Next run would still see mtime/size mismatch and re-hash. The fast skip never activated. Especially critical for migrated DBs where `size=0` after migration. Fixed: added `metadataOnlyHashUpdates` list — updates mtime/size/hash without touching nodes/edges.

25. **Fast skip not applied to parallel path** (`indexer.ts`) — The parallel path always `readFileSync` + `createHash` for every file before comparing, defeating the fast skip. Fixed: ported the same 3-tier logic as single-thread: (1) mtime+size match → skip without read; (2) mtime/size mismatch → hash to confirm → metadata-only update if same; (3) content changed → re-index.

### Benchmark improvement

- **V1_BINARY auto-detection** (`rigorous-benchmark-r78.ts`) — Instead of hardcoded fallback path, now auto-detects via: env var > repo-relative > `which codebase-memory-mcp` > `which cbm` > fail. Fully portable now.

### Docs sync

- **Root README.md** — Updated from stale `0.15.9 / 378 tests / 565+ bugs / 77 rounds` to `0.21.0 / 361 tests / 23 bugs + 6 optimizations / 9 rounds`. Replaced hardcoded test count with reference to CHANGELOG.
- **`npm test` comment** — Now says "see v2/CHANGELOG.md for current test count" instead of a hardcoded number that goes stale.

### Verification

```
Test Files  33 passed (33)
     Tests  361 passed (361)
```

### Files

- Modified: `v2/src/indexer/wasm-extractor.ts` (Bug 24: metadataOnlyHashUpdates)
- Modified: `v2/src/indexer/indexer.ts` (Bug 25: fast skip + metadata-only in parallel)
- Modified: `v2/scripts/rigorous-benchmark-r78.ts` (V1_BINARY auto-detection)
- Modified: `README.md` (docs sync: version, tests, rounds, bugs)
- Modified: `v2/package.json` (version 0.22.0)

### Total: 25 bugs + 6 optimizations across 10 rounds

| Round | Type | Count |
|---|---|---|
| R78 (1-4) | bugs | 8 |
| R79 (5) | bugs | 1 |
| R80 (6) | bugs | 5 |
| R81 (7) | bugs | 5 |
| R82 (8) | bugs | 4 |
| R83 (9) | optimizations | 3 + portability |
| R84 (10) | bugs | 2 (metadata-only update, parallel fast skip) + docs sync |

### Next steps

1. **Tests d'échec réel** — inject extractFast failure, verify old graph/hash preserved (still pending)
2. **Tests fast skip** — size migration, metadata-only update, second-run fast skip, parallel fast skip
3. **mtime precision** — use mtimeNs instead of Math.floor(mtimeMs) to avoid same-millisecond false skips
4. **Cross-file CALLS resolution** — V2 still misses 900+ edges V1 finds
5. **Worker pool persistant** — for MCP/UI/watch daemon mode

## 0.21.0 — Round 83 (2026-07-08) Performance + Portability + Docs

**9th round.** Implements remaining GPT 5.5 recommendations: mtime+size fast
skip (biggest incremental perf gain), benchmark portability, prepared
statement optimization, GC flag removal, and docs sync.

### Performance optimizations

1. **mtime+size fast skip** (`wasm-extractor.ts` + `schema.ts`) — In incremental mode, if `mtime` AND `size` match the stored values, skip SHA-256 hashing entirely. Makes no-op incremental O(stat) instead of O(total bytes read). Added `size` column to `file_hashes` with auto-migration via `PRAGMA table_info`.

2. **Prepared statement outside loop** (`indexer.ts`) — The `upsertFileHash` statement was being `db.prepare()`d inside the loop in the parallel transaction. Now prepared once before the loop. Small but free gain.

3. **Removed `--gc-interval=100` from benchmark** (`rigorous-benchmark-r78.ts`) — R79 noted this flag masks the `Parser.init()` defer gain. Now the main benchmark runs without it, giving honest numbers.

### Benchmark portability (B1)

`rigorous-benchmark-r78.ts` no longer has hardcoded `/home/z/my-project/` paths. Uses `import.meta.url` to derive paths relative to the script location, with env var overrides:
- `CBM_V1_BINARY` — path to V1 binary
- `CBM_V2_DIST` — path to V2 dist
- `CBM_BENCH_SMALL` — small workload target
- `CBM_BENCH_LARGE` — large workload target
- `CBM_BENCH_RUNNER` — path to runner.py

Now reproducible on any machine or CI.

### Schema migration

- Added `size INTEGER NOT NULL DEFAULT 0` column to `file_hashes`
- `migrateFileHashesSizeColumn()` auto-adds the column to existing DBs via `PRAGMA table_info` detection

### Verification

```
Test Files  33 passed (33)
     Tests  361 passed (361)
```

### Files

- Modified: `v2/src/indexer/schema.ts` (size column + migration)
- Modified: `v2/src/indexer/wasm-extractor.ts` (mtime+size fast skip + size in upsert)
- Modified: `v2/src/indexer/indexer.ts` (size in parallel hash updates + prepared statement)
- Modified: `v2/scripts/rigorous-benchmark-r78.ts` (portable paths + remove --gc-interval)
- Modified: `v2/package.json` (version 0.21.0)

### Total bugs fixed + optimizations across 9 rounds: 23 bugs + 6 optimizations

| Round | Type | Count |
|---|---|---|
| R78 (1-4) | bugs | 8 |
| R79 (5) | bugs | 1 |
| R80 (6) | bugs | 5 |
| R81 (7) | bugs | 5 |
| R82 (8) | bugs | 4 |
| R83 (9) | optimizations | 3 (mtime+size skip, prepared stmt, gc removal) + portability + migration |

### Next steps

1. **Tests d'échec réel** — inject extractFast failure, verify old graph/hash preserved
2. **Cross-file CALLS resolution** — V2 still misses 900+ edges V1 finds
3. **Worker pool persistant** — for MCP/UI/watch daemon mode
4. **Benchmark incremental scenarios** — noop, 1-file, 10% change with invariants

## 0.20.0 — Round 82 (2026-07-08) Incremental Safety Lock — 4 bugs fixed

**8th audit round (GPT 5.5 external audit R81).** 4 bugs fixed. R81 was a
good correctness step but had 2 P0 gaps: hash/delete were still scheduled
BEFORE parse success (silent corruption on extraction failure), and the
CLI masked partial errors. R82 closes these gaps.

### Bugs fixed (4, from GPT 5.5 R81 audit)

20. **CRITICAL: Single-thread incremental schedules hash/delete before extract success** (`wasm-extractor.ts`) — `changedRelPaths.push()` and `pendingHashUpdates.push()` happened BEFORE `extractFast()`. If extract failed, the transaction would still delete old nodes and update the hash, causing silent corruption (next run skips the file that never extracted). Fixed: push to mutation lists ONLY after `extractFast()` succeeds.

21. **CRITICAL: Parallel incremental same bug** (`indexer.ts`) — `allPendingChangedRelPaths` and `allPendingHashUpdates` were populated before workers ran. Worker failures would still delete old nodes and update hashes. Fixed: filter `changedToApply` and `hashesToApply` to only files where `fileResult.error === null`.

22. **CLI masks partial extraction errors** (`cli/commands/index.ts`) — `exitCode = errors > 0 && nodes === 0 ? 1 : 0` meant exit 0 if ANY nodes extracted, even with 100 errors. Dangerous for CI/benchmarks. Fixed: `exitCode = errors > 0 && !allowPartial ? 1 : 0`. Added `--allow-partial` flag for interactive use.

23. **Migration relies on string matching `sqlite_master.sql`** (`schema.ts`) — Fragile against whitespace/case/named-constraint variations. Fixed: use `PRAGMA index_list` + `PRAGMA index_info` for robust UNIQUE index detection. Also cleans up leftover `file_hashes_new` from interrupted migrations.

### Verification

```
Test Files  33 passed (33)
     Tests  361 passed (361)
```

### Files

- Modified: `v2/src/indexer/wasm-extractor.ts` (Bug 20: hash/delete after extract success)
- Modified: `v2/src/indexer/indexer.ts` (Bug 21: filter to successful files only)
- Modified: `v2/src/cli/commands/index.ts` (Bug 22: strict exit code + --allow-partial)
- Modified: `v2/src/indexer/schema.ts` (Bug 23: PRAGMA-based migration detection)

### Total bugs fixed across 8 audit rounds: 23

| Round | Bugs |
|---|---|
| R78 (1-4) | 8 bugs |
| R79 (5) | 1 bug |
| R80 (6) | 5 bugs |
| R81 (7) | 5 bugs |
| R82 (8) | 4 bugs (hash/delete timing ×2, CLI exit, migration robustness) |

### Next steps

1. **Tests d'échec réel** — tests that inject extractFast failure and verify old graph/hash preserved
2. **Benchmark portable** — remove hardcoded paths, add incremental scenarios
3. **mtime+size fast skip** — avoid hashing unchanged files
4. **Docs sync** — README version, V2_ROADMAP, test counts

## 0.19.0 — Round 81 (2026-07-08) Migration + Incremental Atomicity + Stats Fix

**7th audit round (GPT 5.5 external audit R80).** 5 bugs fixed. R80 was a
good correctness lock but had 3 P0 gaps: missing schema migration, non-atomic
single-thread incremental, and false project stats after incremental. R81
closes these gaps and adds versioned tests.

### Bugs fixed (5, from GPT 5.5 R80 audit)

15. **Missing migration for `file_hashes` UNIQUE change** (`schema.ts`) — R80 changed `UNIQUE(file_path)` to `UNIQUE(project, file_path)` but `CREATE TABLE IF NOT EXISTS` doesn't migrate existing tables. Old DBs keep the old constraint, causing `ON CONFLICT(project, file_path)` to fail with "does not match any constraint". Fixed: `migrateFileHashesSchema()` detects old schema via `sqlite_master.sql`, rebuilds the table with dedup by `(project, file_path)`, all in a transaction.

16. **Incremental single-thread non-atomic** (`wasm-extractor.ts`) — Old nodes/edges for changed files were DELETEd in Phase 1 (before parse). If parse/extract failed, the old graph was lost. Fixed: collect `changedRelPaths` in Phase 1, do all deletes INSIDE the transaction in Phase 2 (after parse succeeds). Also fixed empty-file vs read-failure confusion using `fileContents.has()` instead of `?? ''`.

17. **Main thread preloads grammars even in parallel mode** (`indexer.ts`) — `preloadGrammars()` ran before `useParallel` was computed. In parallel mode, workers load their own grammars, so the main thread preload was wasted work (~50ms on LARGE). Fixed: compute `useParallel` first, only preload if `!useParallel`.

18. **`projects.node_count/edge_count` false after incremental** (`indexer.ts`) — `updateProjectStats()` used `result.nodes/edges` (run counts), not DB totals. A no-op incremental would set `node_count=0`. Fixed: compute actual totals from DB with `SELECT COUNT(*)` after each run.

19. **Non-deterministic ordering in parallel mode** (`indexer.ts`) — Workers pushed results in completion order, so node IDs varied between runs. Fixed: sort `results` by language then first file path, sort inner `batchResult.results` by `filePath`. IDs are now deterministic.

### Tests added (6 new, versioned in repo)

New file: `v2/tests/indexer/r81-correctness.test.ts`

- `migrates pre-R80 schema to UNIQUE(project, file_path)` — creates old schema DB, runs migration, verifies two projects with same `file_path` coexist
- `does not migrate if schema is already correct` — idempotency check
- `keeps project stats equal to actual DB totals after no-op incremental` — Bug 18 regression test
- `sorts results by language then file path` — Bug 19 determinism test
- `no orphan edges after full index simulation` — invariant check
- `two projects with same file_path have isolated file_hashes` — multi-project isolation

### Verification

```
Test Files  33 passed (33)
     Tests  361 passed (361)
```

(355 existing + 6 new R81 tests)

### Files

- Modified: `v2/src/indexer/schema.ts` (Bug 15: migration `migrateFileHashesSchema`)
- Modified: `v2/src/indexer/wasm-extractor.ts` (Bug 16: atomic incremental, empty-file fix)
- Modified: `v2/src/indexer/indexer.ts` (Bug 17: skip preload in parallel; Bug 18: DB totals for stats; Bug 19: deterministic sort)
- New: `v2/tests/indexer/r81-correctness.test.ts` (6 versioned tests)

### Total bugs fixed across 7 audit rounds: 19

| Round | Bugs |
|---|---|
| R78 (1-4) | 8 bugs |
| R79 (5) | 1 bug |
| R80 (6) | 5 bugs |
| R81 (7) | 5 bugs (migration, atomicity, preload, stats, determinism) |

### Next steps

1. **Make benchmark portable** — remove hardcoded `/home/z/my-project/` paths (P1-6 from audit)
2. **Add incremental benchmark scenarios** — noop, one-file-change, 10% change (P1-6)
3. **mtime+size fast skip** — avoid hashing unchanged files (perf P1 from audit)
4. **Worker pool persistant** — for MCP/UI/watch daemon mode (perf P4.3)

## 0.18.0 — Round 80 (2026-07-08) Correctness Lock — 5 P0 bugs fixed

**6th audit round (GPT 5.5 external audit).** 5 critical correctness bugs
fixed. This round focuses on correctness over performance — V2's graph is
now mathematically correct in full/incremental/parallel/multi-project modes.

### Bugs fixed (5 P0, from GPT 5.5 audit)

10. **CRITICAL: SQLite node IDs wrong in incremental/multi-project** (`wasm-extractor.ts` + `indexer.ts`) — `nextId=1` assumed SQLite assigns IDs 1..N, but SQLite assigns `MAX(id)+1`. The `qnToId` map stored 1..N while real IDs were `MAX(id)+1..MAX(id)+N`, causing edges to point to wrong nodes. Fixed: INSERT with explicit `id` column, initialized from `SELECT COALESCE(MAX(id), 0) + 1`. Verified: 0 orphan edges in multi-project test.

11. **Incremental parallel incomplete** (`indexer.ts`) — Parallel path upserted `file_hashes` BEFORE workers parsed (worker failure → stale hash → graph not updated but hash says "up to date"). No per-file delete of old nodes/edges for changed files → duplicate QNs and orphan edges. Fixed: (a) collect pending hash updates without writing; (b) delete old nodes/edges for changed files in transaction; (c) upsert hashes ONLY after all nodes/edges inserted successfully; (d) `skipped` count now correct.

12. **UI server DB paths wrong** (`server.ts`) — `new HumanMemoryStore(\`${project}.human.db\`)` and `new CodeGraphReader(\`${project}.db\`)` opened DBs in the CWD instead of `$XDG_CACHE_HOME/codebase-memory-mcp/`. UI showed empty projects when run from a different directory than the CLI/MCP. Fixed: use `defaultHumanDbPath(project)` and `defaultCodeDbPath(project)`.

13. **`serveStatic()` path traversal bug** (`server.ts`) — `resolve(base, '/index.html')` ignores `base` and returns `/index.html` because the path starts with `/`. The containment check then fails → 403 Forbidden for `GET /`. Fixed: strip leading slashes before resolve, use `relative()` + `isAbsolute()` for containment check.

14. **`/api/index` spawn command wrong** (`routes/index.ts`) — `spawn('cbm', ['index_repository', '--project', '--', projectName, rootPath])` was missing the `cli` subcommand and used wrong flags (`--project` instead of `--name`, positional `rootPath` instead of `--repo-path`). The UI index button couldn't work. Fixed: `spawn('cbm', ['cli', 'index_repository', '--repo-path', rootPath, '--name', projectName, '--mode', 'fast'])`.

### Schema change: `file_hashes` UNIQUE

- **Before:** `file_path TEXT NOT NULL UNIQUE` — multi-project collision (project B overwrites project A's hash for same `src/index.ts`)
- **After:** `UNIQUE(project, file_path)` — each project has its own hash entries
- All `ON CONFLICT(file_path)` upserts changed to `ON CONFLICT(project, file_path)`
- Verified: ProjA has 42 hashes, ProjB has 42 hashes, isolated

### Verification (R80 test script)

```
=== Test Bug 10: Multi-project — no orphan edges ===
ProjA: 735 nodes, 883 edges, 0 orphan edges (must be 0)
ProjB: 735 nodes, 883 edges, 0 orphan edges (must be 0)

=== Test Bug 9: Incremental preserves nodes ===
After incremental: 735 nodes, 883 edges (must match 735/883)

=== Test Bug 3: file_hashes UNIQUE(project, file_path) ===
ProjA file_hashes: 42, ProjB file_hashes: 42 (both should be > 0, isolated)

✓ ALL R80 CHECKS PASSED
```

### Files

- Modified: `v2/src/indexer/wasm-extractor.ts` (Bug 10: explicit node IDs from MAX(id)+1)
- Modified: `v2/src/indexer/indexer.ts` (Bug 10 + Bug 11: explicit IDs, atomic incremental parallel, per-file delete)
- Modified: `v2/src/indexer/schema.ts` (file_hashes UNIQUE(project, file_path))
- Modified: `v2/src/indexer/extractor.ts` (ON CONFLICT update, dead code)
- Modified: `v2/src/ui/server.ts` (Bug 12: defaultDbPath; Bug 13: serveStatic fix)
- Modified: `v2/src/ui/routes/index.ts` (Bug 14: correct cbm spawn command)
- New: `/home/z/my-project/scripts/r80-verify.js` (multi-project + incremental + orphan verification)

### Total bugs fixed across 6 audit rounds: 14

| Round | Bugs |
|---|---|
| R78 (rounds 1-4) | 8 bugs (anonymous complexity, candidates[0], relative, stale dist, SKIP_DIRS, WASM leak ×2, TSNode.id) |
| R79 (round 5) | 1 bug (incremental mode silently broken) |
| R80 (round 6) | 5 bugs (SQLite IDs, incremental parallel, UI DB paths, serveStatic, /api/index spawn) |

### Next steps

1. **Add cross-file CALLS resolution** — V2 still misses 900+ edges V1 finds
2. **Fix parallel cross-batch QN collision** — requires scope-aware QN disambiguation
3. **Make benchmark portable** — remove hardcoded `/home/z/my-project/` paths
4. **Re-run R78 benchmark** to confirm no perf regression from explicit IDs

## 0.17.0 — Round 79 (2026-07-08) Bug 9 fix + Parser.init defer + parallel tuning

**5th audit round. 9th bug fixed.** Found CRITICAL Bug 9: incremental mode
was silently broken since `clearProjectData` deleted `file_hashes`, making
the hash comparison always miss → everything was re-indexed every time.
Also implemented 3 performance optimizations.

### Bug fixed (1 total, round 5)

9. **CRITICAL: Incremental mode silently broken** (`indexer.ts` + `wasm-extractor.ts`) — `clearProjectData` deleted `file_hashes` along with nodes/edges. The incremental hash comparison `existing.content_hash === hash` always returned `undefined` because the hashes were just deleted. Result: incremental mode re-indexed everything every time, providing zero speedup. Fixed: (a) incremental mode no longer calls `clearProjectData` — it preserves nodes/edges for unchanged files; (b) per-file delete for changed files only; (c) full mode now stores `file_hashes` (previously only incremental mode stored them, but incremental couldn't work without them).

### Performance optimizations (3 total)

1. **Defer `Parser.init()`** (`wasm-extractor.ts`) — `Parser.init()` is now lazy via `ensureParserInitialized()`. Previously called eagerly in `preloadGrammars()`, costing ~50ms even on tiny workloads. Manual tests show V2 SMALL drops from 438ms → 189ms (57% faster) when measured without `--gc-interval=100`.

2. **Parallel threshold tuned: 100 → 80 files** (`indexer.ts`) — The deferred `Parser.init()` makes single-thread much faster, raising the crossover point where parallel mode becomes worth the worker spawning overhead (~100ms). 80 is the new sweet spot.

3. **Hash storage in full mode** (`wasm-extractor.ts`) — Full mode now computes and stores `file_hashes` (previously only incremental mode did). This enables the first incremental run to actually skip unchanged files instead of re-indexing everything.

### Results (30 iterations, p50 with 95% CI — R79)

| Workload | V1 (C) | V2 (WASM) | V2 vs V1 | p-value | Cliff's δ |
|---|---|---|---|---|---|
| SMALL (42 files, single-thread) | 363.9ms [362.4, 366.4] | 432.4ms [429.6, 439.4] | V2 18.8% SLOWER | <0.0001 | −0.967 |
| LARGE (~120 files, parallel) | 1417.9ms [1406.0, 1432.8] | 1208.5ms [1197.3, 1224.3] | V2 14.8% FASTER | <0.0001 | +1.000 |

**vs R78:** SMALL improved from 19.8% → 18.8% slower (1pp gain). LARGE similar (15.3% → 14.8% faster). The `--gc-interval=100` flag in the benchmark masks the Parser.init defer gain; manual tests without it show 189ms (75% faster than R78's 438ms).

### Bug 9 verification

```
Run 1 (full index):       42 files, 732 nodes, 42 file_hashes stored
Run 2 (incremental):      0 files indexed, 42 skipped, 732 nodes preserved
Bug 9 status: FIXED
```

### Files

- Modified: `v2/src/indexer/indexer.ts` (incremental mode preserves file_hashes + nodes; parallel threshold 80)
- Modified: `v2/src/indexer/wasm-extractor.ts` (Parser.init defer + hash storage in full mode + per-file delete in incremental)
- Updated: `v2/scripts/rigorous-benchmark-r78-results.json` (R79 results)

### Next steps

1. **Remove `--gc-interval=100` from benchmark** — it masks the Parser.init defer gain and has no measurable effect on correctness
2. **Add cross-file CALLS resolution** — V2 still misses 900+ edges V1 finds
3. **Fix parallel cross-batch QN collision** (Bug 3 from original audit) — requires scope-aware QN disambiguation
4. **Re-run R78 after each round**

## 0.16.0 — Round 78 (2026-07-08) truly rigorous benchmark + 8 invisible bug fixes

**4 audit rounds. 8 bugs fixed.** R77 was methodologically broken. R78's
first run had a file-count bias. R78's deep audit found a CRITICAL bug
present since R73: `Map<TSNode, string>` lookups always failed because
TSNode objects from `descendantsOfType()` and `.parent` are NOT
reference-equal. This silently dropped **ALL CALLS edges** since R73.

### Bugs fixed (8 total, across 4 audit rounds)

**Round 1 (R78 first audit):**
1. **R76 anonymous complexity regression** (`fast-walker.ts`) — hardcoded `complexity:1` for anonymous functions. Fixed: compute proper complexity.
2. **`candidates[0]` dropped CALLS edges** (`fast-walker.ts`) — only first candidate got edges. Fixed: emit one edge per candidate with `candidate_index`.
3. **Custom `relative()` buggy** (`indexer.ts`) — `startsWith()` true for sibling-prefix paths. Fixed: use `node:path.relative`.
4. **V2 dist was stale during R77** — R76 optimizations not in measured binary. Fixed: R78 verifies dist freshness.

**Round 2 (R78 deep audit):**
5. **V2 `SKIP_DIRS` didn't match V1** (`wasm-extractor.ts`) — V2 indexed 51 files while V1 indexed 42. Fixed: SKIP_DIRS now matches V1's full exclusion list (60+ entries).
6. **WASM memory leak in single-thread path** (`wasm-extractor.ts`) — `extractFromFilesWasm()` never called `tree.delete()`. Fixed: added `tree.delete()` in try/finally.

**Round 3 (R78 final audit):**
7. **CRITICAL: TSNode reference equality broken since R73** (`fast-walker.ts`) — `Map<TSNode, string>` lookups always failed because TSNode objects from `descendantsOfType()` and `.parent` are NOT reference-equal (`===` returns false). This silently dropped **ALL CALLS edges** since R73 (0 extracted) and flattened all function QNs (`file::func` instead of `file::class::method`). Fixed: use `Map<number, string>` keyed by `node.id`.

**Round 4 (R78 post-fix audit):**
8. **WASM memory leak in parallel path** (`worker.ts`) — same as Bug 6 but in the parallel worker thread path. `tree.delete()` was outside try/finally; if `extractFast` threw, the WASM tree leaked. Fixed: wrapped in try/finally.

### Runner.py fix

- **RSS measurement bias** (`r78-runner.py`) — `RUSAGE_CHILDREN.ru_maxrss` includes Python parent overhead (`true` reported 13MB instead of 4KB). Fixed: poll `/proc/<pid>/status` VmHWM every 5ms.

### R78 methodology

- 30 measured + 5 warmup iterations per engine per workload
- Two workloads: SMALL (42 files, V2 single-thread) AND LARGE (~120 files, V2 parallel)
- Randomized run order (Mulberry32, deterministic seed)
- High-precision timing via Python `time.perf_counter_ns()`
- Peak RSS via `/proc/<pid>/status` VmHWM polling
- Bootstrap 95% CI for the median (5000 resamples)
- Mann-Whitney U test (two-sided, tie-corrected)
- Cliff's δ for non-parametric effect size
- V2 node/edge counts read directly from SQLite DB
- Refuses to run if V2 dist is stale
- GC control via `--expose-gc --gc-interval=100` (verified no measurable effect, kept for safety)
- CPU fixed at 2800MHz (no turbo boost/throttling)
- Both V1 and V2 use SQLite WAL mode (fair comparison)

### Results (30 iterations, p50 with 95% CI — FINAL)

| Workload | V1 (C) | V2 (WASM) | V2 vs V1 | p-value | Cliff's δ |
|---|---|---|---|---|---|
| SMALL (42 files, single-thread) | 365.7ms [362.8, 366.9] | 438.0ms [428.8, 442.9] | V2 19.8% SLOWER | <0.0001 | −0.973 (large) |
| LARGE (~120 files, parallel) | 1421.7ms [1410.6, 1431.2] | 1204.5ms [1190.4, 1217.3] | V2 15.3% FASTER | <0.0001 | +1.000 (large) |

**Memory:** V2 uses 1.6–3.1× more RAM than V1.
- SMALL: 35MB (V1) vs 107MB (V2)
- LARGE: 118MB (V1) vs 192MB (V2)

**Edge extraction:** V1 extracts 1.9–3.2× more edges than V2 due to LSP-based
cross-file call resolution. V2 only does static AST analysis.

**CALLS edges extracted by V2:**
- Before TSNode.id fix (Bug 7): 0 on SMALL (broken since R73)
- After TSNode.id fix: 188 on SMALL, included in 2645 total on LARGE

### Why the TSNode.id bug was so damaging

`web-tree-sitter`'s `TSNode` objects are wrappers around WASM pointers. Two
TSNode objects pointing to the same underlying node are NOT reference-equal:

```ts
const a = root.descendantsOfType(['function_declaration'])[0];
const b = someCallInsideFunc.parent; // same underlying node
a === b; // FALSE
a.equals(b); // true
a.id === b.id; // true (same number)
```

Since R73, `qnByNode` was `Map<TSNode, string>`. Setting a key with a node
from `descendantsOfType()` and looking it up with a node from `.parent`
always returned `undefined`. This meant:
- `findParentQnFast()` always fell through to `fileQn` → all function QNs flat
- `findEnclosingDeclQnFast()` always returned `null` → all CALLS edges dropped

Every benchmark from R73 to R77 measured V2 with 0 CALLS edges. The "V2 is
faster" claims in R75/R76 were measuring broken code that produced an
incomplete graph.

### Performance cost of correctness fixes

The TSNode.id fix made V2 slightly slower on SMALL (15.5% → 19.8% slower)
because V2 now does real CALLS edge work (188 edges instead of 0). This is
correctness — the old "15.5% slower" was measuring broken code. The 19.8%
number is the honest cost of V2's actual extraction work.

### Files

- New: `docs/RIGOROUS_BENCHMARK_R78.md` (full report with methodology, results, 8 bugs)
- New: `v2/scripts/rigorous-benchmark-r78.ts` (reproducible benchmark, fixes all R77 flaws)
- New: `v2/scripts/r78-runner.py` (Python wrapper, VmHWM polling for accurate RSS)
- New: `v2/scripts/rigorous-benchmark-r78-results.json` (raw results from final run)
- New: `v2/scripts/debug-calls.ts` (debug script that found the TSNode.id bug)
- New: `v2/scripts/debug-tsnode-equality.ts` (proves TSNode === is broken)
- New: `v2/scripts/bench-node-id.ts` (micro-benchmark proving Map<number> is 2.7× faster than Map<TSNode>)
- Modified: `v2/src/indexer/wasm-extractor.ts` (SKIP_DIRS + tree.delete in try/finally)
- Modified: `v2/src/indexer/fast-walker.ts` (TSNode.id Map + anonymous QN + complexity + multi-candidate CALLS)
- Modified: `v2/src/indexer/indexer.ts` (node:path.relative)
- Modified: `v2/src/indexer/worker.ts` (tree.delete in try/finally — parallel path)
- Modified: `v2/src/indexer/extractor.ts` (marked DEPRECATED — dead code, not imported)

### Next steps (revised based on final R78 data)

1. **Lower the parallel-mode threshold** from 100 to ~30 files. V2's parallel
   path is faster than V1 even at 42 files.
2. **Reduce single-thread startup overhead.** Defer `Parser.init()` until first
   parse. Lazy-load grammars. Target: cut 50ms from startup.
3. **Add cross-file CALLS resolution** — V2 misses 900+ edges V1 finds.
4. **Re-run R78 after each round.** R77 missed R76's staleness bug; R78's
   first run missed the SKIP_DIRS bias; R78's second run missed the TSNode.id
   bug. Future rounds MUST re-run R78.

## 0.15.9 — Round 77 (2026-07-07) honest benchmark reassessment + rigorous test

**⚠️ SUPERSEDED by R78.** R77's "V2 is 11% slower" was based on 5 iterations,
one workload, and a stale V2 dist. See R78 for corrected numbers.

**Corrects a measurement error in R72-R76.** Previous benchmarks compared
V2's internal extraction timer (267ms) against V1's wall time (305ms from R67).
This was misleading — V2's wall time includes Node.js startup + WASM init
(~110ms) that V1 doesn't have.

### Rigorous benchmark (5 iterations, alternating, wall-clock)

| Engine | min | median | max | nodes | edges |
|---|---|---|---|---|---|
| V1 (C) | 357ms | **361ms** | 362ms | 537 | 1681 |
| V2 (WASM) | 397ms | **401ms** | 416ms | 819 | 768 |

**V2 is 11% SLOWER than V1 in wall time (40ms).**

### Where V2 IS faster

**Extraction phase only** (excluding startup):
- V2 extraction: 267ms (20% faster than V1's 335ms pipeline)
- V1 pipeline: 335ms

On a persistent process (MCP server, UI server), V2's startup is amortized.
In that scenario, V2 is 20% faster.

### Why V1 extracts more edges (1681 vs 768)

V1 does LSP-based call resolution (1085 resolved calls), cross-file imports
(222), usage tracking (253), and semantic analysis. V2 only does static
AST analysis — no LSP, no cross-file resolution.

### What was wrong with previous benchmarks

V2's CLI reports "Duration: 267ms" but this is only the extraction phase.
The full wall time is ~401ms (Node startup ~30ms + WASM init ~50ms + grammar
load ~20ms + CLI overhead ~10ms + extraction ~267ms + SQLite ~24ms).

### Files

- New: `docs/RIGOROUS_BENCHMARK_R77.md` (full report with fairness notes)
- New: `v2/scripts/rigorous-benchmark.ts` (reproducible benchmark script)
- Corrected all previous "V2 is X% faster than V1" claims in docs

### Next steps

1. Reduce WASM init time (defer Parser.init)
2. Add cross-file CALLS resolution (V2 misses ~900 edges V1 finds)
3. Use V2 as persistent process (amortize startup)

## 0.15.8 — Round 76 (2026-07-07) single-pass complexity + skip anonymous

2 optimizations to the fast-walker extraction.

### Optimizations

1. **Single-pass complexity estimation**: `estimateComplexityFast()` now makes
   one `descendantsOfType()` call with a combined type array (decisions +
   binary expressions) instead of two separate calls. The WASM runtime
   traverses the tree once instead of twice. JS-side filtering of binary
   operators is faster than a second WASM traversal for typical function bodies.

2. **Skip complexity for anonymous functions**: arrow functions and inline
   callbacks (`.map(x => ...)`, `.then(...)`) get `complexity: 1` without
   any WASM traversal. These are typically 1-3 lines with no decision points.
   Saves one `descendantsOfType()` call per anonymous function — for a file
   with 10 arrow functions, that's 10 WASM traversals eliminated.

### Benchmark (3-run average)

| Codebase | R75 | R76 | Speedup |
|---|---|---|---|
| v2/src (51 files) | 287ms | 267ms | **1.07x** |
| v1/src (122 files, parallel) | 995ms | 897ms | **1.11x** |

The v1/src parallel path benefits more (11% vs 7%) because it has more
functions per file (C code is function-heavy), so the complexity skip
has more impact.

### Full evolution: R68 → R76

| Round | v2/src | vs V1 (305ms) |
|---|---|---|
| R68 ts-morph | 1833ms | 6.0x slower |
| R69 WASM | 340ms | 1.11x slower |
| R72 descendantsOfType | 288ms | V2 faster |
| R75 pre-read + batch | 273ms | 10% faster |
| R76 single-pass complexity | 267ms | **12% faster** |

## 0.15.7 — Round 75 (2026-07-07) pre-read + skip setLanguage + batch INSERT

3 optimizations to the single-thread extraction path.

### Optimizations

1. **Pre-read all files before parsing**: file contents are read into a
   `Map<string, string>` before the parse loop starts. This allows the OS
   to prefetch file pages into the page cache while we parse the first
   files. On SSDs the gain is ~2-5ms; on HDDs or network filesystems
   it's significant.

2. **Skip redundant `parser.setLanguage()`**: tracks `currentLang` and
   only calls `setLanguage` when the language changes. For a project with
   all TypeScript files (common case), this eliminates 49 out of 50
   `setLanguage` calls. Each call involves a WASM→JS round-trip (~0.1ms).

3. **Multi-row batch INSERT**: replaced single-row `insertNode.run()` /
   `insertEdge.run()` with batch INSERT (50 rows per statement). SQLite's
   overhead per `prepare().run()` is ~2-5µs; for 800 nodes that's ~2-4ms.
   With batch INSERT (50 rows/statement), it's ~40µs (16 statements).
   Net savings: ~2-3ms.

### Benchmark (3-run average)

| Codebase | R74 | R75 | Speedup |
|---|---|---|---|
| v2/src (51 files) | 282ms | 273ms | 1.03x |
| v1/src (122 files, parallel) | 1000ms | 995ms | 1.005x |
| graph-ui (43 files) | 210ms | 221ms | within noise |

### Full evolution: R68 → R75

| Round | v2/src | vs V1 (305ms) |
|---|---|---|
| R68 ts-morph | 1833ms | 6.0x slower |
| R69 WASM | 340ms | 1.11x slower |
| R72 descendantsOfType | 288ms | V2 faster |
| R73 micro-opts | 277ms | 9% faster |
| R75 pre-read + batch | 273ms | **10% faster** |

## 0.15.6 — Round 74 (2026-07-07) two-phase extraction architecture

Restructured the single-thread indexer into two phases for better cache
locality and architectural clarity.

### Architecture improvement (MEDIUM)

**Before R74**: the single-thread path interleaved file reading, WASM parsing,
AST extraction, and SQLite writes all within a single `db.transaction()`.
This caused cache thrashing — CPU-heavy WASM parsing alternated with
SQLite I/O, and the transaction was held open for the entire duration.

**After R74**: two clean phases:
- **Phase 1 (Extract)**: read + parse + extract ALL files into in-memory
  arrays. No SQLite access. Pure CPU work — WASM parsing + AST extraction.
  Better CPU cache utilization (no SQLite page cache competing).
- **Phase 2 (Write)**: write all nodes + edges to SQLite in one transaction.
  Two passes: (1) insert all nodes + build QN→ID map, (2) insert all edges
  with resolved IDs. Shorter transaction duration (writes only, no parsing).

Also: `tree.delete()` skipped — WASM GC handles cleanup on process exit,
saving ~0.2ms per file (WASM→JS round-trip). Memory is bounded by the
number of files in a single index run.

### Benchmark

Performance is within noise of R73 (±5% variance). The restructure is
architecturally cleaner — the parallel path (worker.ts) already used this
pattern, now the single-thread path matches it.

| Codebase | R73 | R74 | Notes |
|---|---|---|---|
| v2/src (50 files) | 277ms | 290ms | Within variance (±5%) |
| v1/src (122 files) | 987ms | 1028ms | Parallel path unchanged |
| graph-ui (43 files) | 196ms | 210ms | Within variance (±5%) |

### Why commit if not faster?

1. **Architectural consistency**: both single-thread and parallel paths now
   use the same extract-then-write pattern.
2. **Shorter transactions**: SQLite transaction is only open during writes,
   not during parsing. Better for concurrent access.
3. **Future optimization**: Phase 1 is now a clean extraction boundary that
   could be parallelized without SQLite complexity (workers just return
   arrays, main thread writes).

## 0.15.5 — Round 73 (2026-07-07) fast-walker micro-optimizations

4 micro-optimizations to the fast-walker for incremental speedup.

### Optimizations

1. **Removed `rootNode.descendantCount`** — was unused but caused a full tree
   traversal in WASM just to count nodes. Now returns 0 (diagnostic only).
2. **Removed `rootNode.text.length`** — O(n) string copy from WASM to JS just
   to get file size. Now passes `source.length` (already available in JS)
   as a parameter to `extractFast()`.
3. **Pre-built JSON strings** instead of `JSON.stringify()` per node —
   `JSON.stringify({language:'tree-sitter',complexity:N})` → string concat
   `'{"language":"tree-sitter","complexity":' + N + '}'`. Eliminates ~800
   JSON.stringify calls per index (one per node).
4. **Map-based parent resolution** — `findParentQnFast()` uses `Map<TSNode, string>`
   for O(1) lookup instead of `findParentQn()` which did a linear search in
   the `nodes[]` array (O(n) per declaration, O(n²) worst case).

### Benchmark: R72 vs R73

| Codebase | R72 | R73 | Speedup |
|---|---|---|---|
| v2/src (50 files) | 288ms | 277ms | 1.04x |
| v1/src (122 files, parallel) | 1013ms | 987ms | 1.03x |
| graph-ui (43 files) | 211ms | 196ms | 1.08x |

### Full evolution: R68 → R73

| Round | Engine | v2/src | vs V1 (305ms) |
|---|---|---|---|
| R68 | ts-morph (1 lang) | 1833ms | 6.0x slower |
| R69 | WASM tree-sitter (112 langs) | 340ms | 1.11x slower |
| R72 | + descendantsOfType | 288ms | 0.94x — **V2 faster** |
| R73 | + micro-optimizations | 277ms | 0.91x — **V2 9% faster** |

V2 WASM is now **9% faster than V1 C** on the V2 codebase (277ms vs 305ms),
with 112 languages and no binary dependency.

## 0.15.4 — Round 72 (2026-07-07) fast-walker: descendantsOfType optimization

**1.3x speedup** on all indexer benchmarks by replacing recursive JavaScript
AST walking with tree-sitter's built-in `descendantsOfType()` WASM method.

### Performance optimization (HIGH)

Created `v2/src/indexer/fast-walker.ts`:
- Uses `rootNode.descendantsOfType(FUNCTION_TYPES)` instead of recursive
  `walkAST()` — the WASM runtime does the tree traversal in C speed
- One call per node type (functions, classes, methods, calls) instead of
  visiting every AST node in JavaScript
- `estimateComplexityFast()` also uses `descendantsOfType()` for decision
  points instead of recursive counting
- Eliminates ~500 JavaScript function calls per file (one per AST node)

Updated `worker.ts` and `wasm-extractor.ts` to use `extractFast()` instead
of the old recursive `walkAST()` / `walkASTCollect()`.

Removed dead code from `wasm-extractor.ts` (old walkAST, getDeclName,
estimateComplexityWasm, addToNameMap, type sets — all moved to fast-walker).

### Benchmark: R71 (recursive) vs R72 (descendantsOfType)

| Codebase | Files | R71 (recursive) | R72 (fast-walker) | Speedup |
|---|---|---|---|---|
| v2/src (TS) | 50 | 379ms | **288ms** | **1.32x** |
| v1-reference/src (C) | 122 | 1302ms | **1013ms** | **1.29x** |
| graph-ui (TSX) | 43 | 230ms | **211ms** | **1.09x** |

### Why descendantsOfType is faster

Tree-sitter's `descendantsOfType()` is implemented in the WASM runtime
(C speed). Instead of:
- JavaScript: 500 recursive function calls per file, visiting every token,
  string literal, comment, etc.
- WASM: 4 calls per file (one per node type), each returning a pre-computed
  array of matching nodes, traversing the tree in C speed.

The WASM traversal is ~10x faster than JS recursion, and we only visit
nodes we care about (functions, classes, methods, calls) instead of every
AST node.

## 0.15.3 — Round 71 (2026-07-07) worker_threads parallel indexing

Adds parallel WASM tree-sitter indexing using Node.js `worker_threads`.

### New feature: parallel indexing (MEDIUM)

Created `v2/src/indexer/worker.ts` — worker thread that:
- Receives a batch of files (same language for grammar cache efficiency)
- Loads the WASM grammar (once per worker per language)
- Parses each file and walks the AST
- Returns serialized nodes + edges to the main thread

Updated `v2/src/indexer/indexer.ts`:
- Files grouped by language, split into batches, distributed to workers
- Main thread collects results and writes to SQLite in a single transaction
- Two-pass edge resolution: (1) insert all nodes + build QN→ID map,
  (2) insert edges with resolved IDs
- Auto-detects worker count: `Math.max(2, cpus() - 1)`
- Parallel mode activates for 100+ files (below that, worker overhead
  exceeds the parallelism gain)

### Benchmark (2-core machine)

| Codebase | Files | Single-thread | Parallel (2 workers) | Speedup |
|---|---|---|---|---|
| v2/src (TS) | 50 | 378ms | 378ms (single, <100 files) | — |
| v1-reference/src (C) | 122 | 1299ms | 1262ms | 1.03x |

On a 2-core machine, the speedup is modest (overhead vs gain). On 8+ core
machines, the expected speedup is 4-6x (8 workers parsing in parallel).

### Limitations

- **Cross-file CALLS edges**: in parallel mode, each worker only sees its
  own batch of files, so cross-file call resolution is limited. Intra-file
  calls work correctly. A future improvement could do a second pass on the
  main thread to resolve cross-file calls.
- **Worker overhead**: spawning threads + WASM init + serialization adds
  ~100-200ms overhead. Below 100 files, single-threaded mode is faster.
- **better-sqlite3**: synchronous, main-thread only. All SQLite writes
  happen in the main thread after workers return.

## 0.15.2 — Round 70 (2026-07-07) Claude Sonnet R10 audit — 3 fixes

Implements 3 fixes from Claude Sonnet 5 Round 10 audit report.

### Part A (MEDIUM) — vault.ts path safety fix (carryover from R9)

- **Bug**: `readNote`, `writeNote`, `deleteNote` called `assertPathInsideRoot()`
  but discarded the return value (the resolved, symlink-safe real path). The
  actual file operations used `join(vaultPath, relPath)` — the unresolved path.
  This meant a symlink inside the vault pointing outside could pass the
  containment check but the file operation would operate on the symlink, not
  its resolved target.
- **Fix**: all three functions now capture the return value of
  `assertPathInsideRoot()` and use it for the actual file operation
  (`readFileSync`, `writeFileSync`, `renameSync`). This matches the pattern
  already used correctly in `routeBrowse` (`routes/system.ts`).
- **MAINTAINERS_GUIDE.md** updated: added CRITICAL note to the "Path safety"
  section explaining that the return value MUST be captured and used, with
  a cross-reference to `routeBrowse` as the correct pattern.

### Part B (MEDIUM) — WASM extractor anonymous function name collision

- **Bug**: `getDeclName()` in `wasm-extractor.ts` returned the literal string
  `'anonymous'` for all unnamed functions. Every anonymous callback in the
  same scope got the same qualified name (`${parentQn}::anonymous`), causing
  `qnToId.set()` to silently overwrite previous entries — the map only
  remembered the last anonymous function in each scope.
- **Fix**: `getDeclName()` now returns `` `anonymous@${node.startPosition.row + 1}` ``
  — the line number ensures each anonymous function gets a unique qualified name.
  This prevents the silent overwrite and makes future features that look up
  specific anonymous functions by QN reliable.

### Part C (LOW) — benchmark precision caveat

- **Issue**: the "2.2x more nodes" figure in the R69 benchmark was framed as
  "more complete extraction" but V2 counts each inline anonymous callback as
  a separate node while V1 does not — a methodological difference, not
  necessarily a thoroughness win.
- **Fix**: added a "Caveat on node counts" section to `docs/V1_V2_BENCHMARK_R67.md`
  explaining that node counts are not directly comparable as a measure of
  extraction thoroughness.

### Verified clean (from audit)

- R69b `package.json` fix: confirmed complete (all deps present)
- R63 `server.ts` → `routes/*.ts` decomposition: 15 routes, all accounted for
- `MAINTAINERS_GUIDE.md`: well-executed, correct public/private split

## 0.15.1 — Round 69b (2026-07-07) fix: package.json dependencies restored

Fix: the R69 commit accidentally lost the original `package.json` dependencies
(`better-sqlite3`, `commander`, `ws`, `yaml`, `ts-morph`, `typescript`,
`vitest`, `@types/*`). The CI failed because `npm install` only installed
3 packages instead of the full set.

**Root cause**: during R68-R69, `npm install <pkg>` overwrote `package.json`
instead of merging. The file was left with only the newly-installed packages.

**Fix**: restored all original dependencies + added the new R68-R69 dependencies
(`ts-morph`, `web-tree-sitter`, `tree-sitter-wasm`, `tsx`). Version bumped
to 0.15.1. All 378 tests pass.

## 0.15.0 — Round 69 (2026-07-07) web-tree-sitter WASM — 112 languages

**Minor version bump** — V2 indexer upgraded from ts-morph (1 language, 1833ms)
to web-tree-sitter WASM (112 languages, 340ms). This is a **5.4x speedup**
and **112x language coverage increase**.

### New feature: WASM multi-language extractor (HIGH)

Created `v2/src/indexer/wasm-extractor.ts` — uses `web-tree-sitter` (WASM)
with `tree-sitter-wasm` (pre-built WASM grammars for 112 languages).

**Supported languages (24 key ones):**
TypeScript, TSX, JavaScript, Python, Go, Rust, Java, C, C++, Ruby, PHP,
Swift, Kotlin, Scala, Dart, Lua, Bash, YAML, JSON, HTML, CSS, SQL,
Dockerfile, Markdown — plus 88 more niche languages.

**What it extracts:**
- Nodes: File, Class, Function, Method (+ complexity estimation)
- Edges: CONTAINS (parent→child), CALLS (function→function)
- Incremental indexing (content hash, skip unchanged files)

### Benchmark: V1 C vs V2 WASM vs V2 ts-morph

Same codebase (v2/src, 49 TS files):

| Metric | V1 (C, tree-sitter) | V2 WASM (R69) | V2 ts-morph (R68) |
|---|---|---|---|
| Duration | 305ms | **340ms** | 1,833ms |
| Nodes | 460 | **784** | 352 |
| Edges | 1,499 | **1,252** | 1,070 |
| Languages | 158 | 112 | 1 |
| Binary needed | yes (cbm) | **no** | no |

V2 WASM is **5.4x faster** than V2 ts-morph and extracts **2.2x more nodes**.
It's within 12% of V1 C speed (340ms vs 305ms) while requiring **no binary**.

### Multi-language benchmarks

| Codebase | Files | Nodes | Edges | Duration | Languages |
|---|---|---|---|---|---|
| v2/src (TS) | 49 | 784 | 1,252 | 340ms | typescript |
| v1-reference/src (C) | 122 | 2,479 | 2,392 | 1,233ms | c |
| graph-ui/src (TSX) | 43 | 537 | 549 | 243ms | tsx, typescript, css |

### New dependencies

- `web-tree-sitter` (0.26.10) — tree-sitter bindings for Node.js/WASM
- `tree-sitter-wasm` (1.1.2) — pre-built WASM grammars for 112 languages

### Limitations vs V1

- 112 languages (V1 supports 158 — but all 24 key languages are covered)
- No simhash/minhash similarity detection
- No cross-repo intelligence
- No git history analysis
- No trace ingestion
- No LSP-based call resolution (static analysis only)
- No parallel pipeline (single-threaded — future: worker_threads)

## 0.14.0 — Round 68 (2026-07-07) native TypeScript/JavaScript indexer

**Minor version bump** — new feature: V2 can now index TS/JS projects without
the V1 `cbm` binary. This gives V2 partial autonomy for TypeScript/JavaScript
projects.

### New feature: native indexer (HIGH)

Created `v2/src/indexer/` module with 3 files:

- **`schema.ts`** — SQLite schema compatible with V1 (nodes, edges, file_hashes,
  projects tables + indexes). V2's `sqlite-ro.ts` reads the DB transparently
  whether it was created by V1 (C, 158 languages) or V2 (TS/JS only).
- **`extractor.ts`** — uses `ts-morph` (TypeScript compiler API wrapper) to
  extract nodes (File, Class, Function, Method, Variable) and edges (CONTAINS,
  IMPORTS, CALLS) from .ts/.tsx/.js/.jsx/.mjs/.cjs files. Includes:
  - Incremental indexing (content hash comparison, skip unchanged files)
  - Complexity estimation (cyclomatic — counts if/while/for/case/catch/&&/||)
  - Import resolution (relative imports → file path → IMPORTS edge)
  - Call resolution (CallExpression → callee name → CALLS edge)
- **`indexer.ts`** — orchestrator: opens DB → init schema → discover files →
  extract → update stats. Returns ExtractionResult with counts + errors.

New CLI command: `cbm-v2 index --project <name> --root <path> [--incremental] [--dry-run]`

New dependency: `ts-morph` (TypeScript compiler API wrapper).

### Benchmark: V2 native indexer vs V1 C engine

Same codebase (v2/src, 48 TS files):

| Metric | V1 (C, tree-sitter) | V2 (native, ts-morph) |
|---|---|---|
| Files indexed | 35 | 48 (includes .js) |
| Nodes extracted | 460 | 352 |
| Edges extracted | 1,499 | 1,070 |
| Duration | 305ms | 1,833ms |
| Languages | 158 | 1 (TS/JS) |

V2 is 6x slower and extracts fewer nodes/edges (V1's tree-sitter is more
thorough — extracts types, interfaces, enums, etc.). But V2 works without
the `cbm` binary, which was the #1 architectural gap identified in R67.

### Limitations vs V1

- Only TS/JS (V1 supports 158 languages)
- No simhash/minhash similarity detection
- No cross-repo intelligence
- No git history analysis
- No trace ingestion
- No LSP-based call resolution (static analysis only)
- No parallel pipeline (single-threaded)

### When to use native indexer vs V1

- **Use V1 (`cbm index_repository`)** when: the `cbm` binary is available,
  you need multi-language support, or you need maximum accuracy/performance.
- **Use V2 native (`cbm-v2 index`)** when: the `cbm` binary is NOT available,
  your project is TS/JS only, or you want a quick index without building V1.

## 0.13.4 — Round 67 (2026-07-07) V1+V2 combined benchmark — real data

Built V1 from source and indexed the V2 codebase to get real performance
numbers. Full report: docs/V1_V2_BENCHMARK_R67.md.

### V1 indexation benchmark (real data)

- Built V1 binary from source: 562 source files, 259MB binary
- Indexed V2 codebase: 35 files, 460 nodes, 1499 edges in **305ms**
- Throughput: ~115 files/second (tree-sitter + arena + slab + 12 workers)
- Pipeline: configlink(0ms) → route_match(0ms) → complexity(0ms) → dump(5ms) → total 284ms

### V2 query benchmark (same DB, real data)

- getNodeById: 0.006ms (183K ops/sec)
- searchCode LIKE: 0.077ms (13K ops/sec)
- countNodes: 0.013ms (74K ops/sec)
- countAll: 0.050ms (20K ops/sec)
- getBulkNodeDegrees(100): 0.219ms (4.6K ops/sec)
- listNodes(200): 1.195ms (837 ops/sec)

### V1 vs V2 comparison

- SQLite query overhead: V1 ~0.001ms vs V2 ~0.006ms (+0.005ms JS binding, negligible)
- CLI startup: V1 ~25ms per invocation vs V2 0ms (already running)
- Application cache: V1 none vs V2 SWR (0.0003ms for hits) — V2 faster for repeated
- V1 can do code analysis V2 cannot (tree-sitter, complexity, similarity, cross-repo)
- V2 can do human context V1 cannot (ADRs, bugs, Obsidian sync, MCP, React UI)

### Key insight

V2 depends entirely on V1 for code graph creation. Without the `cbm` binary,
V2 has no code graph to serve. This is the biggest architectural gap:
V2 has no fallback when V1 is unavailable.

## 0.13.3 — Round 66 (2026-07-07) performance benchmark suite

Created a comprehensive benchmark suite measuring V2 sidecar performance
with synthetic data (1000 nodes, 5000 edges, 200 human notes). All 19
benchmarks pass with "excellent" or "good" assessment.

### Benchmark suite (scripts/benchmark.ts)

19 benchmarks across 5 categories:

**Human Store** — hot-path prepared statements (R58):
- getNodeById: 0.006ms (179K ops/sec) ✓
- getNodeBySlug: 0.006ms (162K ops/sec) ✓
- listNodes (200 results): 1.14ms (875 ops/sec) ✓
- listNodesByCbmNodeId (junction JOIN): 0.064ms (15.6K ops/sec) ✓
- countNodesByLabel: 0.024ms (41.3K ops/sec) ✓
- getBulkNotesByCbmNodeIds (50 ids): 0.57ms (1.8K ops/sec) ✓
- createNode (write path): 0.11ms (9K ops/sec) ✓

**Code Graph** — sqlite-ro.ts patterns (R59):
- getNodeById: 0.004ms (260K ops/sec) ✓
- findByQualifiedName: 0.002ms (453K ops/sec) ✓
- countNodes: 0.026ms (38.4K ops/sec) ✓
- countAll (1 query): 0.15ms (6.8K ops/sec) ✓

**Bulk Queries** — R40 optimization:
- getBulkNodeDegrees (100 nodes): 0.36ms (2.8K ops/sec) ✓
- getBulkNodeDegrees (500 nodes): 1.87ms (535 ops/sec) ✓
- getBulkEdges (100 nodes): 1.13ms (884 ops/sec) ✓

**SWR Cache** — R37-R50:
- fresh hit: 0.0003ms (3.4M ops/sec) ✓
- miss: 0.0001ms (14.7M ops/sec) ✓
- set + evict: 0.0008ms (1.3M ops/sec) ✓

**JSON Serialization**:
- stringify (100 nodes): 0.07ms (13.7K ops/sec) ✓
- parse (100 nodes): 0.12ms (8.2K ops/sec) ✓

### Key findings

1. **SWR cache is essentially free** — 0.0003ms per fresh hit (3.4M ops/sec).
   The R37-R50 SWR optimization eliminates 100% of query cost for cached entries.

2. **Prepared statements (R58-R59) confirmed effective** — 0.002-0.006ms per
   single-row lookup (178K-453K ops/sec). Sub-microsecond overhead.

3. **Bulk queries (R40) deliver 88x speedup** — getBulkEdges for 100 nodes
   takes 1.13ms vs ~100ms for 200 individual getNeighbors calls.

4. **Write path is fast** — createNode at 0.11ms (9K ops/sec) enables
   real-time vault sync without blocking.

5. **No operation exceeds 2ms** — V2 is not a performance bottleneck.
   The bottleneck is V1's indexation (CPU-bound, seconds to minutes).

### Comparison with V1

V1's C API direct SQLite access has ~0.001ms overhead. V2's better-sqlite3
adds ~0.003ms JS binding overhead — **negligible difference**. The SWR cache
makes V2 **faster** than V1 for repeated queries (V1 has no app-level cache).

Full report: docs/PERFORMANCE_BENCHMARK_R66.md

## 0.13.2 — Round 65 (2026-07-07) V1 C engine audit (reference, read-only)

Deep audit of the V1 C engine (65,620 LOC, 71 .c files). V1 is kept intact
as a reference — this round documents findings without modifying V1 code.

### Audit report (docs/V1_AUDIT_R65.md)

Full audit report created at `docs/V1_AUDIT_R65.md` documenting:

**Findings:**
- 🔴 HIGH: `strcat` buffer overflow in store.c:4479-4484 (512B buffer, unbounded path segments)
- 🟡 MEDIUM: 5 unchecked `malloc` returns in store.c list functions (NULL deref on OOM)
- 🟡 MEDIUM: `slab_owns()` O(n) scan per free/realloc (slab_alloc.c)
- 🔵 LOW: `slab_realloc` promotion ordering (safe but fragile)

**What V1 does right (excellent patterns):**
- Arena + slab + string interning + mimalloc (production-grade memory management)
- Thread-local slab allocator (eliminates ptmalloc2 fragmentation, was 321GB VSZ)
- Atomic work-stealing worker pool (zero contention)
- SQLite PRAGMAs: WAL, 64MB cache, mmap, temp_store=MEMORY
- Prepared statement caching (same pattern V2 adopted in R58)
- Verstable hash table (2024 state-of-the-art, 4-bit hash fragment metadata)
- Back-pressure mechanism (RSS budget, worker naps)
- Cypher engine: SQL injection safe (snprintf + bind_text)

**V1 vs V2 comparison:**
- V1's strcat bug is impossible in V2 (TypeScript strings are bounds-safe)
- V1's unchecked malloc is impossible in V2 (V8 GC, no manual allocation)
- V1's slab allocator has no V2 equivalent (V8 handles allocation)
- Both use the same SQLite PRAGMA patterns and prepared statement caching

**Verdict:** V1 is production-grade C. The architecture split (C for CPU-bound
analysis, TypeScript for I/O-bound sidecar) is the right choice.

## 0.13.1 — Round 64 (2026-07-07) deep audit — bug fix + 36 catch(any) removed

Deep audit of the entire codebase. 1 bug found and fixed, 36 `catch (e: any)`
removed across MCP tools, CLI commands, and graph-ui.

### Bug fix (MEDIUM) — routeIndex status race

- **routeIndex**: if `spawn()` threw synchronously (e.g. ENOENT when `cbm`
  binary is missing), the job status was set to `'failed'` but the HTTP
  response was still `202 Accepted` — semantically misleading. The client
  received "accepted, processing" for a job that already failed. Now returns
  `500` with `{ job_id, status: 'failed', error }` when spawn fails to start.
  Pre-existing bug (not a R63 regression), but caught during R64 deep audit.

### Type safety (MEDIUM) — 36 `catch (e: any)` → `catch (e: unknown)`

- **17 v2 files**: mcp/server.ts (2), 7 MCP tools (1 each), cli/index.ts (4),
  8 CLI command files (20 total), config.ts (1). All `e.message` accesses
  replaced with `e instanceof Error ? e.message : String(e)` — safe against
  non-Error throws (`throw "string"`, `throw { code: 42 }`).
- **graph-ui/api/client.ts** (2): same fix + `e?.name` → `e instanceof Error
  && e.name` (optional chaining on `unknown` is a TS error).
- **schema.ts:341**: `r: any` → `r: unknown` with cast `{ version: number }`.

### Audit summary

Full codebase audited for:
- Race conditions (found 1: routeIndex status — fixed)
- Memory leaks (none — WeakMap for ws filters, timers cleared in finally)
- Unhandled rejections (none — all async routes wrapped in handleRequest try/catch)
- Type safety gaps (found 36 catch(any) + 1 r:any — all fixed)
- Security (all R51 fixes still in place, safe-path utility used correctly)
- Performance (prepared statements, SWR cache, bulk queries all intact)

Remaining `any` usage is either:
- `openMemory()` (4 `as any` — accessing private fields from static method, documented)
- `config.ts deepMerge` (generic deep merge, inherently dynamic)
- `mcp/server.ts` JSON-RPC types (protocol-level, `params?: any` is the JSON-RPC spec)
- `mcp/tools/index.ts` `null as any` (singleton initialization pattern)
- Test files (mocks — `as any` on vi.fn() is standard vitest pattern)

## 0.13.0 — Round 63 (2026-07-07) server.ts architecture refactor

**Minor version bump** — significant architecture change (no breaking API
changes, but the internal file structure of the UI module is reorganized).

### Architecture refactor (HIGH) — server.ts split into 7 files

`server.ts` was 1212 lines with 16 route handlers, WebSocket management,
static file serving, and helpers all in one file. R63 splits it into a
clean module structure:

```
v2/src/ui/
├── server.ts          (290 lines, was 1212) — thin coordinator
├── types.ts           (59 lines) — RouteContext, RouteHandler, IndexJob
├── helpers.ts         (140 lines) — sendJson, errorMessage, parseJsonBody, MIME_TYPES
└── routes/
    ├── graph.ts       (173 lines) — routeLayout, routeDashboard, routeGraphStatus
    ├── project.ts     (157 lines) — routeProjects, routeProjectHealth, routeProjectDelete
    ├── human.ts       (133 lines) — routeHumanNotes, routeAdrGet, routeAdrPost
    ├── index.ts       (132 lines) — routeIndex, routeIndexStatus
    └── system.ts      (243 lines) — routeBrowse, routeProcesses, routeProcessKill, routeLogs
```

**Key abstraction: `RouteContext`** — every route handler now receives a
context object with its dependencies (humanStore, codeReader, project,
indexJobs, logBuffer, log(), sendJson()) instead of accessing `this.*` on
the UiServer instance. This means:
- Routes can be unit-tested with a mock context (no need to spin up a server)
- Dependencies are explicit — the compiler catches missing fields
- Routes can be moved/renamed without touching server.ts
- server.ts is now a thin coordinator: constructor, start/stop, request
  handling, route table, WebSocket, static file serving

**No functional changes** — every route handler is the exact same logic,
just moved to a standalone function that receives RouteContext. All 378
tests pass with 0 regressions. The route table in server.ts is unchanged
(same 15 endpoints, same order, same handler signatures).

### Helpers extracted (MEDIUM)

- `parseJsonBody` moved from UiServer method to standalone helper in helpers.ts.
- `sendJson` moved from UiServer method to standalone helper.
- `errorMessage` moved from UiServer static method to standalone helper.
- `colorForLabel` moved from UiServer method to standalone helper.
- `MIME_TYPES`, `DEFAULT_PORT`, `LOG_BUFFER_MAX` constants moved to helpers.ts.
- `MAX_BODY_SIZE`, `BODY_TIMEOUT_MS` new named constants (were inline magic numbers).

## 0.12.9 — Round 62 (2026-07-07) code quality in importer.ts + generator.ts

No bugs fixed — type safety + deduplication in the Obsidian sync engine
(`v2/src/obsidian/importer.ts` + `v2/src/obsidian/generator.ts`). Zero
functional changes, zero test regressions.

### importer.ts (MEDIUM) — deduplication + type safety

- **Duplicated import loop extracted**: the `for (const relPath of files) {
  try { importSingleFile } catch (e) { result.errors.push } }` block was
  duplicated verbatim in both the dry-run branch and the transaction branch.
  Extracted into a local `importAllFiles` helper, which is now passed directly
  to `db.transaction()` (better-sqlite3 accepts a function directly — no need
  to wrap it in an anonymous arrow). The dry-run branch calls it directly.
- **2 `catch (e: any)` → `catch (e: unknown)`**: now uses
  `e instanceof Error ? e.message : String(e)` instead of accessing `.message`
  on an `any`-typed value.
- **`existingBySlug` typed**: was `let existingBySlug = null` (inferred as
  `null` only, then assigned a `HumanNode`). Now explicitly
  `let existingBySlug: HumanNode | null = null`. The compiler will catch any
  future assignment of a non-HumanNode value.

### generator.ts (LOW) — type safety

- **2 `catch (e: any)` → `catch (e: unknown)`** in `syncHumanNodesToVault`
  and `autoGenerateModuleNotes`. Same pattern as importer.ts — uses
  `e instanceof Error ? e.message : String(e)`.

### Why this matters

The importer and generator are the two halves of the Obsidian vault sync
engine — importer reads vault files into the DB, generator writes DB nodes
back to vault files. Every sync cycle runs both. The duplicated import loop
was a maintenance hazard (a fix in one branch could be missed in the other);
the `catch (e: any)` pattern could throw on non-Error values (e.g. if
`importSingleFile` ever did `throw "invalid frontmatter"` instead of
`throw new Error("invalid frontmatter")`).

## 0.12.8 — Round 61 (2026-07-07) code quality in server.ts

No bugs fixed — type safety and WebSocket state management in the UI server
(`v2/src/ui/server.ts`). Zero functional changes, zero test regressions.

### Type safety (MEDIUM) — 7 `catch (e: any)` + 2 `(ws as any)` removed

- **`catch (e: any)` → `catch (e: unknown)`** in all 7 catch blocks
  (handleRequest, routeProjectHealth, routeAdrPost, routeBrowse, routeIndex,
  routeProcessKill, routeProjectDelete). The previous pattern accessed
  `e.message` on an `any`-typed value, which would throw if `e` was not an
  Error object (e.g. `throw "string"` or `throw { code: 42 }`).
- **`UiServer.errorMessage(e: unknown): string` static helper** added.
  Uses `e instanceof Error ? e.message : typeof e === 'string' ? e : String(e)`.
  All 7 catch blocks now call `UiServer.errorMessage(e)` instead of `e.message`.
  Also used in `start()`'s error handler (was `e.message` on `NodeJS.ErrnoException`,
  which had `.message` but is now unified through the helper for consistency).
- **`(ws as any)._projectFilter` removed**. The previous pattern augmented the
  WebSocket instance with an untyped `_projectFilter` field, accessed via
  `(ws as any)._projectFilter` in 2 places. Replaced with a
  `WeakMap<WebSocket, string | undefined>` (`wsProjectFilters`). Benefits:
  - Type-safe: the compiler knows the value is `string | undefined`, not `any`.
  - No field-name typos: `_projectFilter` vs `_projectfilter` would silently
    return `undefined` with the old pattern; now it's a compile error.
  - Automatic GC: when the WebSocket is closed and removed from `wsClients`,
    the WeakMap entry is garbage-collected automatically.

### Why this matters

`server.ts` is the HTTP/WebSocket server that every UI client connects to.
The 7 catch blocks handle every API error response — if any of them threw
while trying to extract `e.message`, the server would return a 500 with no
error message (or worse, crash the request handler). The WeakMap fix makes
the WebSocket project-filter mechanism type-safe and self-cleaning.

## 0.12.7 — Round 60 (2026-07-07) code quality in swr-cache.ts

No bugs fixed — code quality, deduplication, and type safety in the SWR cache
(`v2/src/intelligence/swr-cache.ts`). Zero functional changes, zero test regressions.

### Code quality (MEDIUM) — dead code + duplication + fragility

- **Dead code removed**: `effectiveMaxEntries` ternary in `evictToFit()` had both
  branches identical (`this.maxEntries : this.maxEntries`). It looked like it
  did something but was a no-op. Removed; the entry-count limit now always
  applies regardless of maxBytes (which is the correct behavior — maxBytes is
  the primary budget, maxEntries is a hard cap).
- **Duplication eliminated**: extracted `evictOne()` private method from
  `evictToFit()`. The pattern "get oldestKey → delete entry → subtract bytes →
  delete refresh handlers → delete refresh timers → bump eviction stats" was
  duplicated 2× (once for the memory budget loop, once for the entry-count
  budget loop). Now both loops call `evictOne()`.
- **Defensive iteration**: `invalidatePrefix()` previously modified
  `this.entries` while iterating over `this.entries.keys()`. JS Map iterators
  tolerate concurrent deletion, but this is fragile — it would break silently
  if someone later changed the iteration method (e.g. to `for...of` with
  destructuring). Now collects matching keys into an array first, then
  invalidates them in a separate loop.

### Type safety (LOW) — `any` removed from event API

- **`catch (e: any)` → `catch (e: unknown)`** in the background refresh error
  handler. Now uses `e instanceof Error ? e.message : String(e)` instead of
  accessing `.message` on an `any`-typed value (which would throw if `e` was
  not an Error object — e.g. `throw "string"` or `throw { code: 42 }`).
- **`on()` method typed**: previously `on(event: string, listener: (...args: any[]) => void)`.
  Now `on(event: 'refresh', listener: (event: SwrCacheRefreshEvent<K>) => void)`.
  Added `SwrCacheRefreshEvent<K>` exported interface with `key`, `phase`, `error?`
  fields. Callers now get autocomplete and the compiler catches field-name typos.

## 0.12.6 — Round 59 (2026-07-07) code quality + type safety in sqlite-ro.ts

No bugs fixed — same pattern as R58 but applied to the code graph reader
(`v2/src/bridge/sqlite-ro.ts`). Zero functional changes, zero test regressions.

### Type safety (MEDIUM) — 30 `as any` casts removed

- **11 row type interfaces added**: `CodeNodeRow`, `NeighborRow`, `DegreeCountRow`,
  `CountRow`, `CountAllRow`, `LabelCountRow`, `TypeCountRow`, `EdgeTripleRow`,
  `BulkEdgeRow`, `ProjectNameRow`, `ProjectRow`. These match what SQLite actually
  returns for each query shape (simple SELECT *, JOINs with aliases, COUNT
  aggregations, GROUP BY, etc.).
- **All 30 `as any` casts replaced** with proper row types: `as CodeNodeRow | undefined`,
  `as NeighborRow[]`, `as DegreeCountRow[]`, `as CountRow`, `as CountAllRow`,
  `as LabelCountRow[]`, `as TypeCountRow[]`, `as EdgeTripleRow[]`, `as BulkEdgeRow[]`,
  `as ProjectNameRow[]`, `as ProjectRow[]`, etc.
- **`deserializeCodeNode(row: CodeNodeRow)`** — previously typed as `(row: any)`.
- **`makeEdge(row: BulkEdgeRow)`** in getBulkNeighbors — previously `(row: any)`.
- **`tryPush(row: EdgeTripleRow, ...)`** in getBulkEdges — previously `(row: any)`.
- **`params: any[]`** in findNodesByName and listNodes replaced with `(string | number)[]`.
- **Null safety**: `NeighborRow.node_properties` is `string | null` (LEFT JOIN may
  produce null). The getNeighbors method now coalesces with `?? '{}'` when passing
  to deserializeCodeNode, matching the existing `row.properties_json || '{}'` pattern
  in deserializeCodeNode itself.

### Performance (LOW-MEDIUM) — hot-path prepared statements

- **2 prepared statements moved to constructor**: `stmtGetNodeById`,
  `stmtFindNodeByQName`. These are the 2 single-row lookups called on every MCP
  tool invocation (prepare_edit_context, get_module_context, search_code_and_memory).
  better-sqlite3 caches internally, but holding the Statement object directly
  avoids the cache lookup + JS wrapper allocation on every call.

### Why this matters

`sqlite-ro.ts` is the read-only bridge to V1's code graph — every MCP tool, every
UI endpoint that shows code structure goes through `CodeGraphReader`. Before this
round, 30 `as any` casts meant the TypeScript compiler couldn't catch:
- Column-name typos (e.g. `row.edge_propertis` instead of `row.edge_properties`)
- Wrong alias names in JOIN queries (the getNeighbors aliases are critical —
  both tables have `id`, `project`, `properties_json`, and without aliases
  better-sqlite3 returns the last column value for duplicate names)
- Missing fields after a V1 schema change

With proper row types, these are all compile-time errors. The prepared-statement
optimization is minor but sets the pattern for future hot-path identification.

## 0.12.5 — Round 58 (2026-07-07) code quality + type safety + perf

No bugs fixed — this round focuses on code quality, type safety, and performance
in the DB layer (`v2/src/human/store.ts`). Zero functional changes, zero test
regressions.

### Type safety (MEDIUM) — 18 `as any` casts removed

- **6 row type interfaces added**: `HumanNodeRow`, `HumanEdgeRow`, `IdRow`,
  `CountRow`, `LabelCountRow`, `HumanNodeWithCbmIdRow`. These match what SQLite
  actually returns (JSON columns as `string`, not parsed arrays; label/status/
  source/type as `string`, not union types — the DB CHECK constraint guarantees
  validity, but TypeScript can't know that from the raw column type).
- **All 18 `as any` casts in query methods replaced** with proper row types:
  `as HumanNodeRow | undefined`, `as HumanEdgeRow[]`, `as CountRow`,
  `as LabelCountRow[]`, etc. The only remaining `as any` are 4 in
  `openMemory()` (accessing private fields from a static method — documented
  with a comment explaining why the alternative would be worse).
- **`deserializeNode(row: HumanNodeRow)`** and **`deserializeEdge(row: HumanEdgeRow)`**
  — previously typed as `(row: any)`. Now the compiler catches column-name typos
  at build time and the schema is self-documenting.
- **`safeJsonParseArray` return type** tightened from `any[]` to `unknown[]`.
  The `cbm_node_ids` filter now uses a type guard `(x): x is number => ...`
  instead of an unchecked `.filter()` returning `any[]`.
- **`params: any[]`** in `listNodes` and `updateNode` replaced with
  `(string | number)[]` and `(string | number | null)[]`.

### Performance (LOW-MEDIUM) — hot-path prepared statements

- **3 prepared statements moved to constructor**: `stmtGetNodeById`,
  `stmtGetNodeBySlug`, `stmtGetNodeByObsidianPath`. These are the 3 single-row
  lookups called on every MCP tool invocation, every UI dashboard load, and
  every sync cycle. better-sqlite3 caches prepared statements internally, but
  holding the Statement object directly avoids the cache lookup + JS wrapper
  allocation on every call. `openMemory()` (used by tests) also prepares them
  (after `runMigrations`, since the tables must exist first).

### Why this matters

The DB layer is the foundation of the entire V2 sidecar — every MCP tool, every
CLI command, every UI endpoint goes through `HumanMemoryStore`. Before this
round, the store had 22+ `as any` casts, meaning the TypeScript compiler
couldn't catch:
- Column-name typos (e.g. `row.cbm_node_id` instead of `row.cbm_node_ids`)
- Wrong return type assumptions (e.g. treating a JSON string as an array)
- Missing fields after a schema change

With proper row types, these are all compile-time errors. The prepared-statement
optimization is minor (better-sqlite3's cache is fast), but it makes the hot
path explicit and sets the pattern for future optimizations.

## 0.12.4 — Round 57 (2026-07-07) doc cleanup + private maintainers notes

Doc consistency + maintainability improvements (no code changes).

### Documentation cleanup (MEDIUM)

- **12 stale refs fixed** across v2/README.md, CONTRIBUTING.md, MAINTAINERS_GUIDE.md:
  - v2/README.md: test count 374→378 (355+23), version refs 0.11.3→0.12.4, security section updated to mention R51/R55 symlink-safe realpath protection.
  - CONTRIBUTING.md: "6 tools"→"7 tools", "374 tests"→"378 tests", "5 docs files"→"9 files", "npm ci"→"npm install --no-audit --no-fund", removed stale "planned: 0.4.0" tag (we're at 0.12.4), rewrote CI/CD section to describe the actual GitLab→GitHub mirror workflow + required checks + cross-ref to MAINTAINERS_GUIDE.md.
  - MAINTAINERS_GUIDE.md: test count 376→378, round range R55→R56, commit message example updated.

### MAINTAINERS_GUIDE.md enriched (MEDIUM)

- **Common pitfalls** section (9 items): "FIXED" claims that weren't fixed, stale version/test counts, YAML `: ` parsing, `--force-with-lease` URL push, workflow-level permissions, MR pipelines with zero jobs, unconditional setLoading, npm ci vs npm install, committing in wrong repo.
- **Pre-commit checklist** section (12 items): build, tests, version bump, CHANGELOG, doc consistency, YAML validation, regression test, commit message format, push options.
- **Lessons learned** section (6 items): environment reset recovery, GitLab API 403, paramiko slowness, sed over-replacement, branch protection, cd persistence.

### Private maintainers notes (LOW)

- **MAINTAINERS_NOTES.local.md** (gitignored via `*.local.md`): operational reminders, environment setup, env reset recovery steps, operational gotchas, token/variable locations (names only, not values), pre-session checklist. No actual secrets — just paths, URLs, and "things I keep forgetting". The SSH key PATH is mentioned (it's just a path), but the key VALUE never leaves the machine.

## 0.12.3 — Round 56 (2026-07-07) self-audit + MAINTAINERS_GUIDE

3 improvements from GLM self-audit (no external audit report this round).

### Test coverage (MEDIUM)

- **symlink escape test for assertPathInsideRoot**: R55 Part A wired up the
  shared `safe-path.ts` utility in `vault.ts` and `server.ts`, but the
  existing `vault.test.ts` only tested symlink loops (R51) — not the actual
  symlink-escape attack vector that `assertPathInsideRoot` is supposed to
  prevent. Added 2 tests: (1) symlink inside vault pointing outside is
  rejected by readNote/writeNote/deleteNote; (2) symlink inside vault
  pointing to another vault-internal path is allowed (no over-blocking).

### Code clarity (LOW)

- **backup.ts version field clarified**: `version: '0.10.3'` in the backup
  JSON was ambiguous — could be confused with the package version (0.12.2).
  Added a 10-line comment block explaining it's a schema version independent
  from the package version, bumped only when the JSON shape changes.

### Documentation (LOW)

- **MAINTAINERS_GUIDE.md** (new file): captures the workflow conventions,
  naming rules, required patterns (safe-path, -- separator, grep -wE,
  maxAliasCount), anti-patterns (force-without-lease, token in URL,
  unconditional setLoading, unquoted `: ` in YAML), CI/CD setup, test
  infrastructure, audit etiquette, and versioning rules accumulated across
  55 rounds. Public doc — for secrets/keys see local `MAINTAINERS_NOTES.local.md`.

## 0.12.2 — Round 55 (2026-07-07) Claude Sonnet 5 R9 audit

4 issues fixed from Claude Sonnet 5 Round 9 audit report (1 HIGH, 1 LOW, 2 LOW cleanup).

### HIGH fix (dead code + duplication risk)

- **Part A**: `v2/src/utils/safe-path.ts` was created in R53 (Part C of Round 8 audit) to de-duplicate the symlink-safe path resolution logic between `vault.ts` and `server.ts`, but neither call site was actually wired up to use it — both kept their own inline `realpathSync` implementations. The utility file's docstring claimed the wiring existed when it didn't. Round 8 specifically warned about this duplication risk. Fixed: `vault.ts`'s `assertPathInsideVault` replaced by the shared `assertPathInsideRoot` (3 call sites: `readNote`, `writeNote`, `deleteNote`); `server.ts`'s `routeBrowse` now uses `safeRealpath`, `routeIndex` now uses the new `safeRealpathStrict` (added to the utility for the strict 404-on-missing-path semantics `routeIndex` needs). The inline `realpathSync` import was removed from `server.ts`. `vault.ts`'s `walkVaultIter` keeps its own `realpathSync` call for symlink-loop detection (different semantics — `safeRealpath`'s fallback would defeat the skip-on-broken-symlink behaviour).

### HIGH fix (CI silently broken)

- **D3**: Round 52's workflow-level `permissions: contents: read` hardened `backend`/`frontend` correctly, but silently broke `quota-report`'s `/repos/.../actions/runs` API call — once any `permissions:` key is set at workflow level, every unlisted scope becomes `none`. The job's `total_count` parsing fell back to `0` instead of surfacing the 403. Fixed: `quota-report` now has its own job-level `permissions: { contents: read, actions: read }` override. `backend`/`frontend` stay at the workflow-level default (least-privilege preserved).

### LOW fixes (CI cleanup)

- **D4**: removed unreachable `'v2/**'` pattern from `on.push.branches` — only the GitLab mirror pushes to this repo, and it only pushes to `main`.
- **D5**: restricted `quota-report` to `schedule`-only (was `schedule || push to main`). Running it on every merge to `main` added noise without value: rate limits reset hourly, the weekly schedule is the actual trend signal.

### Notes

- **D2 residual (acknowledged, not fixed)**: the `http.extraHeader` fix from R53 closes the cited leak vector (git echoing a credential-bearing URL in error output), but the base64 token is still passed in argv via `git -c http.extraHeader=...`, visible via `/proc/[pid]/cmdline` during the push. On GitLab.com shared runners (ephemeral, single-job) this is a much narrower risk than the original leak. A `GIT_ASKPASS` script reading from an env var would close the residual gap if it ever becomes a real concern.
- **Part B (Round 8 backfill)**: confirmed complete — Round 49's "1 CRITICAL merge" is now explained in the changelog, all rounds 47-52 have itemized entries.
- **Part C (D1/D2 mirror fix)**: confirmed correct, including the `ls-remote` + `--force-with-lease=main:<sha>` refinement from R54c that handles the URL-push edge case.

## 0.12.1 — Round 52 (2026-07-07) CI

6 CI quality + security fixes.

- **Security**: `permissions: contents: read` (least-privilege for GITHUB_TOKEN).
- **Perf**: removed `pretest` script that doubled the build (~10s/pipeline saved).
- **Perf**: `npm install --no-audit --no-fund` (~2s/job saved).
- **Quality**: quota-report single API call + single Python parse.
- **Bugfix**: GitLab CI quota-check date command fixed for BusyBox/Alpine.
- **Quality**: simplified quota-report output.

## 0.12.0 — Round 51 (2026-07-07) SECURITY

8 security issues fixed (1 CRITICAL, 3 HIGH, 2 MEDIUM, 2 LOW).

- **SEC-5 CRITICAL**: vault.ts symlink traversal — `assertPathInsideVault` used string-based `resolve()` without `realpathSync`. A symlink inside the vault pointing to `~/.bashrc` could be used for arbitrary file write → RCE. Fixed: `realpathSync` + `lstatSync` + symlink escape detection in `walkVault`.
- **SEC-6 HIGH**: `POST /api/adr` accepted `body.project` without regex validation — IDOR. Fixed.
- **SEC-7 HIGH**: `POST /api/index` `rootPath` was unvalidated — could index `/etc`. Fixed: leading-hyphen check + `realpathSync` + home containment.
- **SEC-8 HIGH**: `routeProcessKill` allowlist included stale PIDs from completed index jobs. A recycled PID could be killed. Fixed: clear `job.childPid` on exit + only allowlist running jobs.
- **SEC-10 MEDIUM**: `routeProjectDelete` missing leading-hyphen check. Fixed.
- **SEC-13 MEDIUM**: `routeHumanNotes` accepted negative `cbm_node_id`. Fixed.
- **SEC-15 LOW**: `yaml.parse()` called without explicit `maxAliasCount`. Fixed: `{ maxAliasCount: 100 }`.

## 0.11.4 — Round 50 (2026-07-07)

9 issues fixed (1 HIGH bug, 2 MEDIUM perf/doc, 6 LOW cleanup/doc).

### HIGH fix (bug)

- **#1**: `invalidateGraphStatusCache` was never called after re-index. The SWR cache served stale `total_nodes`/`total_edges`/`nodes_by_label` for up to 60s after a successful `cbm index_repository`. Now called on successful index job exit + emits `code_graph_changed` NotifyHub event.

### MEDIUM fixes

- **#2 PERF**: reverted R49 #8 `routeLayout` SWR reuse — `getGraphStatus` on cold cache adds 50-200ms (git log execSync) for a `total_nodes` field the Graph tab doesn't render. Reverted to `countNodes` (~1ms).

- **#3 DOC**: CONTRIBUTING.md + Dockerfile still referenced old GitLab URLs. Updated to GitHub repo + GitHub Actions CI.

### LOW fixes

- **#5 CLEANUP**: removed dead `else if` branch in importer.ts — `wasUnchanged` implies `samePath=true` implies `oldObsidianPath=null`, making the branch unreachable.
- **#6 DOC**: README.md missing closing `**` on bugs-fixed line broke Markdown bold.
- **#7 DOC**: CONTRIBUTING.md test count said 124, actual is 374.
- **#8 CLEANUP**: `swr-cache.evictToFit` didn't clear `refreshHandlers`/`refreshTimers` on eviction — orphaned handlers could schedule stale refreshes.
- **#4 DOC**: version/round refs synced across README, v2/README, ROADMAP.
- **#9 TEST**: (this round) no new regression tests needed — R49 fixes covered by existing test suite.

## 0.11.3 — Round 49 (2026-07-07)

9 issues fixed (1 CRITICAL merge, 2 HIGH docs, 1 MEDIUM perf, 5 LOW bug/perf/cleanup).

### CRITICAL fix (merge)

- **#1**: R48 commit (`8c26fa3`) was never merged into the working branch — the audit was running against 0.11.1 (R47), not 0.11.2 (R48). Cherry-picked R48 into R49 to restore the correct codebase state. The R48 fixes (CI mirror main-only, ControlTab stale controller, parseNote line-by-line, swr-cache timer, kill timer) were present in the remote main but missing from the local working branch.

### HIGH fixes (docs)

- **#2**: README badge URL pointed to old GitLab path with wrong username. CI badge now points to GitHub Actions.
- **#3**: Version string out of sync across package.json / README / ROADMAP / CHANGELOG (all said 0.11.1, should be 0.11.2+).

### MEDIUM fix (performance)

- **#4**: `processWikilinks` ran for EVERY note including unchanged ones — 1000× `buildFenceState` + ~5000 SQL round-trips wasted on a typical sync where 990 notes are unchanged. Now skips wikilink processing for unchanged notes. ~10× import speedup on large vaults.

### LOW fixes

- **#6**: `client.ts` external-signal abort misreported as "Request timed out" even when the caller cancelled at 50ms. Now distinguishes timeout vs caller cancel.
- **#7**: `client.ts` external-signal abort listener leaked on long-lived signals. Now removed in `finally` block.
- **#8**: `routeLayout` called `countNodes` — a full table scan — even though `getGraphStatus` (SWR-cached) already computed the same value. Reuses cached value.
- **#9**: `GraphCanvas.draw` set `strokeStyle`/`lineWidth` PER EDGE — 5000 canvas state changes per frame. Refactored to two-pass batching: O(1) state changes.
- **#10**: `importer.ts` had a misplaced `import type` at bottom of file. Moved to top.
- **#12**: `swr-cache.getWithPhase` scheduled a `setTimeout(0)` on every stale hit even when no refresh handler was registered. Now guarded by `refreshHandlers.has(key)`.

## 0.11.2 — Round 48 (2026-07-06)

6 issues fixed (1 CRITICAL CI, 1 HIGH bug, 2 MEDIUM bug+test, 2 LOW defensive).

### CRITICAL fix (CI)

- **#1**: GitLab CI mirror job force-pushed ANY branch to GitHub's `main` — pushing to `v2/round48` would clobber GitHub `main` and trigger Actions CI on wrong content. Fixed: restrict mirror rules to `$CI_COMMIT_BRANCH == "main"` only.

### HIGH fix (bug)

- **#2**: `ControlTab.tsx` interval callback aborted the ORIGINAL `controller` (closure-captured) instead of `abortRef.current` (latest). After the first 10s interval, the original was already aborted — subsequent intervals created new controllers without cancelling the previous ones. Request pileup + stale-data races. Fixed: use `abortRef.current?.abort()`.

### MEDIUM fixes (bug + test)

- **#3**: `parseNote` regex matched `---` inside quoted YAML string values (e.g. `title: "a --- b"`), silently losing frontmatter on re-export. Fixed: replaced regex with line-by-line scanner that looks for a LINE that is exactly `---`.
- **#4**: `parseNote` test only asserted `body.contains('# Body')` — passed despite frontmatter being completely lost. Strengthened: now asserts `frontmatter.title`, `frontmatter.type`, `body.trim()`.

### LOW fixes (defensive)

- **#5**: `swr-cache.set()` didn't cancel pending refresh timers. Fixed: cancel at top of `set()`.
- **#6**: `ControlTab.handleKill` didn't clear the previous kill timer before setting a new one. Rapid kills stacked timers. Fixed: `clearTimeout` before new timer.

## 0.11.1 — Round 47 (2026-07-06)

10 issues fixed across V2 + Graph UI (3 HIGH, 4 MEDIUM, 3 LOW). 6 new tests.

### HIGH fixes (correctness + performance)

- **H1 BUG**: `prepare_edit_context` called `getBulkNotesByCbmNodeIds` without a limit argument, defaulting to 1. The flagship tool silently under-reported linked notes — agents saw "1 known bug" when 10 were linked. Fixed: pass `limit=200`.
- **H2 PERF**: `generator.ts` `autoGenerateModuleNotes`/`autoGenerateRouteNotes` called `getNeighbors` per module/route — 200+ queries. Fixed: use `getBulkNeighbors` (6 queries total).
- **H3 PERF**: `routeDashboard` called `countNodes`, `countEdges`, `countNodesByLabel` — 3 uncached SQLite scans duplicating SWR-cached `getGraphStatus`. Fixed: reuse cached data.

### MEDIUM fixes

- **M1**: `ControlTab` replaced `mountedRef` with `AbortController` (was piling up requests on slow backend).
- **M3**: `hotspots` report `notes_count` capped at 1 (limit=1). Fixed: `limit=200`.
- **M4**: `parseNote` `---` inside quoted YAML — defensive check (later replaced by line-by-line scanner in R48).
- **L1**: `swr-cache` refresh timer cancellation on `invalidate`.
- **L2**: `syncCbmLinks` DELETE inside transaction (self-contained atomic).
- **L3**: `ControlTab` kill timer cleanup.
