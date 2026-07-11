# V2 Current State — Codebase Memory V2

> **Authoritative snapshot of the current product state.** Updated R165 (2026-07-12).
> For the historical roadmap, see [V2_ROADMAP.md](V2_ROADMAP.md) (archive, 0.15.9 era).
> For the authoritative version and bug count, see `v2/package.json` and `v2/CHANGELOG.md`.

## Architecture

Codebase Memory V2 is a **hybrid** code intelligence system:

1. **V2 Native WASM Indexer** — 112 languages via `tree-sitter-wasm`. Partially autonomous: can index TS/JS projects without V1.
2. **V1 C Engine** — 158 languages via tree-sitter C. Fallback for languages V2 doesn't cover natively.
3. **V2 Human Memory Layer** — ADRs, bug notes, refactor plans, conventions, risk assessments. Obsidian vault sync. Graph UI. 7 MCP tools.

Both indexers write to the same V1-compatible SQLite schema, so `CodeGraphReader` reads either transparently.

## R153 — Alias History + Warning Propagation

R153 (round 78) closes the silent historical-target deletion vector introduced
by R152. When a symlink alias was previously valid and is now broken (ENOENT
or ELOOP on realpath), the old canonical target's data is preserved:

- **`alias_history` table** (`schema.ts`): persists `alias_path`,
  `canonical_target`, `target_kind`, `last_seen_success_at` across full
  reindexes. Garbage-collected entries for aliases no longer on disk.
- **Discovery tracking** (`wasm-extractor.ts`): `resolvedAliases` (realpath
  succeeded) and `brokenAliases` (ENOENT/ELOOP) are returned in
  `DiscoveryResult`.
- **Indexer protection** (`indexer.ts`): for each broken alias with a
  history entry, the old canonical target is added to a protected paths
  set. File targets get exact-match protection; directory targets get
  subtree-prefix protection. In incremental mode, protected paths are
  filtered from `deletedRelPaths`. In full mode, any protected path
  forces `hasUncertainty=true` (abort the full to preserve the graph).

R153 also completes the warning propagation work started in R152:

- **All return paths** now include `warnings` (dry-run, partial discovery,
  full uncertainty, no-op, deletion-only, main).
- **All warning codes** now carry a root-relative path (ENOENT_LSTAT,
  ENOENT_STAT, ENOENT_IDENTITY, ENOENT_REALPATH_DIR added).
- **Typed `outcome` field** in `IndexResult`: `SUCCESS` |
  `SUCCESS_WITH_WARNINGS` | `STALE` | `PARTIAL` | `FAILED`. The CLI prints
  warnings BEFORE the outcome banner, and the banner text reflects the
  outcome.
- **Dry-run shows warnings** (R152 gated them with `!opts.dryRun`).
- **Exact sample count**: `count - samplePaths.length` instead of `count - 5`.

### Known limitations (R153, closed in R154)

- ~~**Alias history cold start**~~: **CLOSED in R154**. The cold-start lock
  now fires when `alias_history_initialized=0` OR
  `discovery_policy_version < CURRENT_DISCOVERY_POLICY_VERSION` AND there
  are broken aliases AND existing nodes. The lock blocks all deletions
  (incremental) and forces hasUncertainty (full) until a successful run
  populates the history and sets the version.
- **No cross-process alias_history lock**: concurrent indexers on the same
  project could race on the alias_history table. This is the same race
  window as the rest of the SQLite write path (mitigated by `busy_timeout`).
- **Full publication non-atomic** (carryover P1): a crash after
  `clearProjectData` but before extraction completes leaves a partial graph.
  Future round will implement `project.db.next` + atomic rename.
- **DB dialect divergence** (carryover P1): V1 uses `rel_path`/`sha256`,
  V2 uses `file_path`/`content_hash`. The README's "shared V1-compatible
  schema" claim is partially true — `CodeGraphReader` reads both, but a
  V1 DB cannot be migrated to V2 in-place. Future round will add
  `GraphDbDialect` detection.

## R154 — Bootstrap + Root Identity + Atomic State

R154 (round 79) closes the cold-start, root-identity, contribution, visibility,
and atomicity gaps identified in the R153 audit:

- **Cold-start lock** (`MIG-R154-01`): added `alias_history_initialized` and
  `discovery_policy_version` columns to the projects table. The indexer reads
  the bootstrap state: if not initialized AND broken aliases AND existing nodes,
  the cold-start lock fires (blocks all deletions, forces full-mode uncertainty).
  After a successful run, both are set and normal protection applies.
- **Root fingerprint** (`ALIAS-R154-01`): added `root_fingerprint` column
  (`canonicalRoot:st_dev`). The UNIQUE constraint is now
  `(project, root_fingerprint, alias_path)`. Reusing the same project name
  with a different root does NOT inherit stale history.
- **Contribution filter** (`ALIAS-R154-02`): only contributive aliases are
  historized — file aliases require `detectLanguage !== null`; directory
  aliases require at least one discovered file under the prefix. Non-contributive
  aliases (txt, FIFO, empty dir) are still tracked as warnings but NOT persisted.
- **Target visibility check** (`ALIAS-R154-03`): broken aliases with a still-visible
  target (directly or via another alias) do NOT force stale. Only genuinely
  absent targets are protected.
- **Atomicity** (`TX-R154-01`, `TX-R154-02`): try/finally around persistAliasHistory
  guarantees db.close() even on exception. The residual non-atomicity (graph fresh
  before history persist) is documented; a full atomic transaction is deferred to R160.
- **Run-id GC** (`PERF-R154-01`): replaced `NOT IN (?, ?, ...)` dynamic GC
  with `last_observed_run_id` stamping + `DELETE WHERE run_id != current`.
  O(1) SQL regardless of alias count.
- **Outcome contract** (`OUTCOME-R154-01`): `--allow-partial` now ONLY masks
  PARTIAL. FAILED is always exit 1, STALE is always exit 2.
- **CHECK constraint** (`SCHEMA-R154-01`): `target_kind` has
  `CHECK(target_kind IN ('file', 'directory'))`.

`CURRENT_DISCOVERY_POLICY_VERSION = 1` (separate from extractor semantics v8 —
tracks policy, not AST output).

## R155 — Atomic Alias State + Fingerprint v2 + Special File Safety

R155 (round 80) closes the atomicity, root-identity, special-file, and
scalability gaps identified in the R154 audit:

- **Atomic alias state commit** (`TX-R155-01`): new
  `commitAliasStateAtomically()` helper combines alias_history UPSERT + GC +
  project stats (fresh + initialized + policy + root_fingerprint) in a SINGLE
  transaction. If persist fails, the ENTIRE transaction rolls back — the graph
  stays stale, `alias_history_initialized` stays 0, `last_successful_index_at`
  is NOT advanced. The next run's cold-start check correctly detects the
  uninitialized state. All 3 success paths (no-op, deletion-only, main) use
  this helper.
- **Root fingerprint v2** (`ROOT-R155-01`): fingerprint is now
  `canonicalRoot:st_dev:st_ino` (was `canonicalRoot:st_dev`). On recreate,
  `st_ino` changes on most filesystems, producing a new fingerprint. On
  untrustworthy filesystems (dev=0, ino=0), falls back to
  `canonicalRoot:untrusted`. Discovery policy version bumped to 2.
- **Special file type safety** (`ALIAS-R155-01`): `resolvedAliases.push` moved
  INTO the `isFile()` and `isDirectory()` branches. Special files (FIFO,
  socket, device) are never historized.
- **Scalable GC** (`PERF-R155-01`): replaced `IN (?, ?, ...)` dynamic stamping
  with a prepared UPDATE per alias. No dynamic SQL, no variable limit.
- **Legacy row cleanup** (`MIG-R155-01`): GC now uses
  `last_observed_run_id IS NULL OR != ?` to catch legacy NULL rows. A separate
  `DELETE WHERE root_fingerprint=''` cleans up pre-R154 rows.
- **UUID runId** (`CONC-R155-01`): `runId = randomUUID()` instead of
  `Date.now()`. `last_observed_run_id` column type changed from INTEGER to TEXT.
- **EXISTS bootstrap** (`PERF-R155-04`): cold-start lock uses
  `SELECT EXISTS(... LIMIT 1)` instead of `COUNT(*)`. Also checks `file_hashes`.
- **STALE outcome contract** (`OUTCOME-R155-01`): STALE outcome now uses
  `errors: []` (was `errors: [{...}]`). The contract `errors>0 → FAILED` is
  respected.
- **Dry-run failure banner** (`OUTCOME-R155-02`): dry-run with errors shows
  "Dry-run failed" instead of "Dry-run complete".

`CURRENT_DISCOVERY_POLICY_VERSION = 2` (bumped from 1 — fingerprint format
change forces re-population of alias_history).

## R156 — CI Hotfix + Truthful State + Directory Alias + Graph UI Bridge

R156 (round 81) closes the CI blocker, the truthful-state gap, and the
directory-alias duplicate identified in the R155 audit, plus adds the
GitHub ↔ GitLab branch bridge for graph-ui contributions:

- **CI blocker fix** (`CI-R156-01`): R155 imported `mkfifoSync` from
  `node:fs`, which doesn't exist in Node.js. The TypeScript typecheck
  failed, blocking ALL backend CI on every MR. Fixed by replacing
  `mkfifoSync` with `spawnSync('mkfifo', ...)` wrapped in a `createFifo()`
  helper that returns `false` on Windows/macOS.
- **Truthful state on commit failure** (`TX-R156-01`): the indexer now
  pre-marks `cross_file_calls_stale=1` BEFORE extraction (only on the
  main path). If `commitAliasStateAtomically` fails, the pre-marked
  stale=1 remains truthfully set — the graph IS stale (extraction
  committed in its own transaction, but the projects row can't rollback
  to stale=0). The catch block also best-effort persists the commit
  error message. If the commit succeeds, it clears stale=0 atomically.
- **Directory alias duplicate historization** (`ALIAS-R156-01`):
  `resolvedAliases.push` is now BEFORE the `visitedDirs.has` dedup check.
  Two aliases (aliasA, aliasB) to the same directory are BOTH historized
  — history and traversal are separate concerns.
- **Structured staleReason + recovery** (`OBS-R156-01`): `IndexResult`
  now carries `staleReason?: { code, message, paths }` and
  `recovery?: 'retry_incremental' | 'fix_filesystem' | 'full_reindex' |
  'none'`. The full-uncertainty return builds a structured staleReason
  with code in {DISCOVERY_UNCERTAIN, HISTORICAL_ALIAS_BROKEN,
  COLD_START_LOCK}. The CLI displays the message, affected paths, and
  recovery recommendation.
- **Non-circular cold-start message** (`AVAIL-R156-01`): the cold-start
  lock message now says "Fix or remove the broken symlinks (see paths
  below), then rerun." instead of the circular "run a successful full
  index first". The recovery field is `'fix_filesystem'`.
- **GitLab MR CI gate** (`CI-FLOW-R156-01`): replaced the echo-only
  `mr-preflight` job with a real `github-ci-gate` job that pushes the
  MR's SHA to a temporary GitHub branch, triggers the `gitlab-mr-ci`
  workflow via `repository_dispatch`, polls for the conclusion, and
  fails the GitLab pipeline if GitHub CI failed. The new
  `gitlab-mr-ci.yml` workflow runs backend + frontend typecheck/build/test
  on the MR's SHA. Transitional: `allow_failure: true` until the
  workflow is on GitHub main.
- **graph-ui branch sync** (`CI-FLOW-R156-01`): new
  `sync-graph-ui-to-gitlab.yml` workflow runs after the upstream `CI`
  workflow succeeds on a `graph-ui/**` branch. It pushes the SHA to
  GitLab under the same name and creates/updates a GitLab MR. Uses
  `workflow_run` trigger to access repository secrets safely. See
  [GITHUB_GITLAB_BRANCH_BRIDGE.md](GITHUB_GITLAB_BRANCH_BRIDGE.md) for
  the architecture and security model.

### Known limitations (R156)

- **`github-ci-gate` is `allow_failure: true`** (transitional): until the
  `gitlab-mr-ci.yml` workflow is on GitHub main (after this MR merges and
  mirrors), the gate is non-blocking. A follow-up commit should remove
  `allow_failure: true`.
- **graph-ui sync only triggers on `graph-ui/**` branches**: other
  branches don't get the GitHub PR → GitLab MR bridge.
- **`persistAliasHistory` is dead code** (`QUAL-R156-01`): R155 replaced
  it with `commitAliasStateAtomically` for all success paths. Kept as a
  stable API for external callers (MCP tools).

## R159 — True Orchestrator + Discriminated Result

R159 (round 84) closes the 6 confirmed code findings of the R158 audit. R158
left two structural gaps: (1) the main path had no outer try/catch/finally,
so exceptions during `preloadGrammars`/`extractFromFilesWasm`/`indexParallel`/
`deleteTx`/totals/`updateProjectStats` escaped without a structured failure
and without a guaranteed DB close; (2) the classifier's priority order
(`SEMANTICS_MISMATCH` first) created circular recovery when both a filesystem
blocker AND a semantics mismatch were present.

### True orchestrator: outer try/catch/finally (`indexer.ts`)

- **Outer try/catch/finally around the ENTIRE main path** (`RES-R159-01`):
  wraps `preloadGrammars` through the final return. The outer catch returns
  `FAILED` with `failure: { code: 'EXTRACTION_CRASH', phase: 'main-path' }`
  and best-effort persists `stale=1` + `last_index_error`. The outer
  `finally` is the ONLY `db.close()` for the main path — the inner
  `db.close()` calls (in the crossFileStale branch and the PERSIST_FAILURE
  finally) have been removed. The inner try/catch around
  `commitAliasStateAtomically` remains (provides specific PERSIST_FAILURE
  diagnosis). The no-op and deletion-only fast paths return BEFORE the outer
  try and keep their own `db.close()`.

### Discriminated result: classifier priority + extraction-error handling (`indexer.ts`)

- **Classifier priority reordered** (`OUTCOME-R159-01`): filesystem blockers
  (`COLD_START_LOCK`, `HISTORICAL_ALIAS_BROKEN`) now come BEFORE
  `SEMANTICS_MISMATCH`. Rationale: if the filesystem is broken, recommending
  `full_reindex` is circular — the full will be blocked by the broken alias
  on the next run. R158 put `SEMANTICS_MISMATCH` first, creating a circular
  recovery loop. R159 fixes the filesystem FIRST, then does the full reindex.
  New priority: `COLD_START_LOCK → HISTORICAL_ALIAS_BROKEN →
  SEMANTICS_MISMATCH → DISCOVERY_UNCERTAIN → PREVIOUSLY_STALE`.
- **Extraction errors no longer mislabeled as PREVIOUSLY_STALE**
  (`OUTCOME-R159-02`): R158's main-path `staleReason` builder fell back to
  `{ code: 'PREVIOUSLY_STALE', message: indexError }` when the classifier
  returned `undefined` (extraction errors). This recommended `full_reindex`
  — wrong when the cause is per-file extraction errors (the right recovery
  is `retry_incremental`). R159: when the classifier returns `undefined`,
  `staleReason` is `undefined`. The per-file errors are in `result.errors[]`;
  `outcome` is `PARTIAL` or `FAILED` based on `errors.length`. The `recovery`
  field falls back to `retry_incremental` when `crossFileStale &&
  !mainClassified`.

### Discriminated FAILED: structured failure on ALL FAILED paths (`indexer.ts`)

- **Early FAILED paths now carry a `failure` field** (`API-R159-01`): R158
  only added `failure: { code, message, phase }` to the three
  publication-failure catch blocks. The early FAILED paths (root-validation,
  discovery, discovery-partial, dry-run-root, dry-run-discovery) set
  `outcome: 'FAILED'` but no `failure` field — programmatic consumers
  couldn't triage by phase/code. R159 adds
  `failure: { code: 'DB_ERROR', message, phase: '<specific-phase>' }` to
  each. The full set of phases is now: `dry-run-root`, `dry-run-discovery`,
  `root-validation`, `discovery`, `discovery-partial` (full + incremental
  branches), `no-op-commit`, `deletion-only-commit`, `main-commit`
  (PERSIST_FAILURE), and `main-path` (EXTRACTION_CRASH).

### Observability: cap signal + CLI display (`indexer.ts`, `cli/commands/index.ts`)

- **`staleReason.totalPaths` + `pathsTruncated`** (`OBS-R159-03`): R158
  capped `paths` at `MAX_STALE_PATHS = 100` but exposed no signal that
  truncation occurred. A user with 5000 broken symlinks saw "100 paths" and
  thought that was the total. R159 adds `totalPaths: number` (pre-cap count)
  and `pathsTruncated: boolean`. Consumers can now display
  "(showing 100 of 5000)".
- **CLI displays `result.failure`** (`CLI-R159-01`): R158 added the
  `failure` field but the CLI never surfaced it. R159 prints
  `System failure: / Code: / Phase: / Message:` in the PARTIAL/FAILED
  banner and the dry-run failure banner. The STALE banner also surfaces
  truncation info: "Affected paths (showing 100 of 150):" when
  `pathsTruncated` is set.

### Tests

21 new tests in `tests/indexer/r159-true-orchestrator.test.ts`:

- 3 tests for classifier priority (COLD_START_LOCK wins over
  SEMANTICS_MISMATCH, HISTORICAL_ALIAS_BROKEN wins over SEMANTICS_MISMATCH,
  SEMANTICS_MISMATCH alone still works).
- 1 test for extraction-error handling (no staleReason, recovery=
  retry_incremental) — uses `CBM_TEST_FAIL_ON_FILE` to inject an extraction
  error.
- 3 tests for the `failure` field on early FAILED paths (root-validation,
  dry-run-root, discovery-partial).
- 2 tests for the outer try/catch/finally (extraction crash → FAILED +
  EXTRACTION_CRASH + main-path phase; DB still readable after crash).
- 2 tests for `totalPaths` + `pathsTruncated` (150 aliases → truncated; 50
  aliases → not truncated).
- 3 CLI process-spawn tests (missing root → "System failure: Code: DB_ERROR
  Phase: root-validation"; dry-run missing root → dry-run-root phase; 150
  aliases → "showing 100 of 150").
- 6 source-inspection regression guards (classifier priority order, outer
  try/catch/finally, all FAILED paths carry failure, staleReason type
  carries totalPaths/pathsTruncated, main-path staleReason builder doesn't
  fall back to PREVIOUSLY_STALE, CLI prints failure + truncation).

### Known limitations (R159)

- **`failure.code = 'UNKNOWN'` not yet emitted** (carryover): only
  `PERSIST_FAILURE`, `EXTRACTION_CRASH`, and `DB_ERROR` are emitted today.
  `UNKNOWN` is reserved for future use.
- **`classifyStaleReason` is still a private helper** (design choice, R158
  carryover): not exported. Tested indirectly via
  `IndexResult.staleReason.code`.
- **Outer catch loses partial `result` info** (design choice): when
  `extractFromFilesWasm` partially succeeds then `deleteTx` crashes, the
  outer catch returns `nodes: 0, edges: 0` instead of the partial result.
  This is intentional — the catastrophic failure is more important than the
  partial result, and the premark ensures `stale=1` is in the DB.

## R158 — Publication Orchestrator + Unified staleReason Classifier

R158 (round 83) closes the residual publication-state and classifier gaps
that R157 left in place. R157 added catch blocks to the three success
paths (no-op, deletion-only, main), but the catches only wrapped
`commitAliasStateAtomically`, used hand-rolled `staleCode` builders with
inconsistent priority, and left the `errors[]` array empty on
publication failure (making programmatic triage impossible).

### Publication orchestrator + unified classifier (`indexer.ts`)

- **Unified `classifyStaleReason()` function** (`OBS-R158-01/02/03`):
  a single function with priority order
  SEMANTICS_MISMATCH → HISTORICAL_ALIAS_BROKEN → COLD_START_LOCK →
  DISCOVERY_UNCERTAIN → PREVIOUSLY_STALE. All three stale return paths
  (no-op, deletion-only, main) now call it with the same params. R157's
  no-op path always returned `PREVIOUSLY_STALE` (even when the real
  cause was semantics mismatch or historical alias), and its
  deletion-only path returned `SEMANTICS_MISMATCH` with an empty
  message for non-semantics cases. The classifier also adds
  HISTORICAL_ALIAS_BROKEN and COLD_START_LOCK to the fast paths (R157
  only emitted them on the full-uncertainty path).
- **Structured `failure` field on `IndexResult`** (`OUTCOME-R158-01`):
  `failure?: { code: 'PERSIST_FAILURE' | 'EXTRACTION_CRASH' | 'DB_ERROR'
  | 'UNKNOWN'; message: string; phase: string }`. All three catch blocks
  (no-op-commit, deletion-only-commit, main-commit) populate it.
  `errors[]` is now reserved for per-file extraction errors only —
  R157's `errors: []` on publication failure made programmatic triage
  impossible (consumers had to string-match `staleReason.message`).
- **`staleReason.paths` capped at 100** (`PERF-R158-01`): a repo with
  thousands of broken symlinks used to produce a multi-MB `IndexResult`
  that MCP and Graph UI serialized through stdout/websocket, causing OOM
  and GC pauses. Now capped at `MAX_STALE_PATHS = 100` — the field is
  for human triage, not exhaustive enumeration.
- **Premark UPSERT updates `root_path`** (`ROOT-R158-01`): R157's
  premark `INSERT ... ON CONFLICT DO UPDATE SET` clause set
  `cross_file_calls_stale`, `last_index_attempt_at`, and
  `last_index_error` but NOT `root_path`. A project reconfigured to a
  new root kept the old `root_path` until the final commit. If the
  final commit failed, the DB was left with stale=1 and the OLD
  root_path, so Graph Status showed the wrong root. R158 adds
  `root_path = excluded.root_path` to the ON CONFLICT clause in BOTH
  premark UPSERTs (main path + deletion-only path).

### Graph UI bridge hardening (`.github/workflows/sync-graph-ui-to-gitlab.yml`)

- **Full fetch instead of `--depth=1`** (`SYNC-R158-01`): R157's path
  guard ran `git fetch origin main --depth=1` then
  `git diff --name-only origin/main...HEAD`. If main had advanced since
  the branch was created, the shallow fetch had no merge-base and the
  diff failed. R158 uses a full fetch (`git fetch origin main`).
- **`remove_source_branch=true` on PUT too** (`SYNC-R158-02`): R157
  added the flag to the POST (create) call but not the PUT (update)
  call. An MR created before R157 wouldn't have the flag set, so the
  source branch wouldn't be auto-deleted on merge. R158 adds it to PUT.
- **Fail loudly if `MR_COUNT > 1`** (`SYNC-R158-03`): R157 silently
  took the first MR when duplicates existed — masking the duplication.
  R158 fails the workflow with a diagnostic message and the JSON list.

### Tests

16 new tests in
`tests/indexer/r158-publication-orchestrator-classifier.test.ts`:

- 4 tests for `classifyStaleReason` priority (SEMANTICS_MISMATCH,
  HISTORICAL_ALIAS_BROKEN, COLD_START_LOCK, PREVIOUSLY_STALE) — each
  triggered indirectly via `indexProjectWasm` to verify the runtime
  code path.
- 3 tests for `failure` field on FAILED outcome (no-op, deletion-only,
  main path) — using `vi.mock` + `vi.hoisted` to inject
  `commitAliasStateAtomically` failures.
- 1 test for `staleReason.paths` cap at 100 (150+ broken aliases →
  exactly 100 paths).
- 2 tests for `root_path` UPSERT propagation (main + deletion-only
  path).
- 6 source-inspection regression tests guarding against accidental
  removal of the `failure` type, the three catch-block `failure:`
  assignments, the `classifyStaleReason` call sites, `MAX_STALE_PATHS`,
  `root_path = excluded.root_path` in both UPSERTs, and the
  sync-graph-ui workflow changes.

### Known limitations (R160)

- **`failure.code = 'RESOLVER_ERROR' | 'UNKNOWN'` not yet emitted**
  (carryover): the expanded R160 taxonomy declares `ROOT_ERROR`,
  `DISCOVERY_ERROR`, `DISCOVERY_PARTIAL`, `DB_ERROR`, `EXTRACTION_CRASH`,
  and `PERSIST_FAILURE` — all emitted on the appropriate FAILED paths.
  `RESOLVER_ERROR` is reserved for cross-file resolver crashes (currently
  mapped to `DB_ERROR` during the cleanup phase) and `UNKNOWN` is reserved
  for unforeseen failures. Both will be emitted in a future round.
- **`classifyStaleReason` is a private helper** (design choice): not
  exported. Tested indirectly via `IndexResult.staleReason.code`. If
  MCP/UI consumers need to call it directly, export it in a follow-up.
- **Full-uncertainty return is hand-rolled** (design choice): the
  `!opts.incremental && hasUncertainty` return at the top of the main
  path uses a hand-rolled staleCode builder (not `classifyStaleReason`)
  because it constructs a different message (with broken-alias counts)
  and a different recovery mapping. R161 (OBS-R161-01) added
  `totalPaths`/`pathsTruncated` to the classifier's return type so the
  three callers (no-op, deletion-only, main) now surface them — but the
  full-uncertainty return remains hand-rolled for the message/recovery
  differences. A future round may unify these.

## R165 — CAS Miss Re-read + Final-state Snapshot Marker

R165 (round 90) closes the 6 confirmed code findings of the R164 audit:

- **CAS miss re-read** (`CONC-R165-01`, P1/P2): R164's CAS UPDATE on the
  root-change early returns (`ROOT_CHANGED` and `ROOT_IDENTITY_UNKNOWN`)
  correctly detected when another indexer had changed the projects row
  between our read and write (`info.changes === 0`). But R164 then
  returned STALE/FAILED WITHOUT re-reading the DB to determine what
  actually happened. This was overly conservative for the case where the
  concurrent indexer published successfully under THIS root — the DB was
  actually fresh, not stale. R165 re-reads the projects row on
  `info.changes === 0` and distinguishes three cases:
    - **Row deleted** → `DB_STATE_INCONSISTENT` (`persistFailure=true`,
      returns FAILED/PERSIST_FAILURE).
    - **currentState.fp === rootFingerprint (current root)** (ROOT_CHANGED
      only) → another indexer published the SAME root. Returns STALE with
      "Concurrent indexer published this root successfully" +
      `recovery: 'none'` + `crossFileCallsStale: false` (the graph IS fresh).
    - **currentState.fp !== rootFingerprint** (ROOT_CHANGED) or
      **currentState.fp === null || currentState.stale !== 0**
      (ROOT_IDENTITY_UNKNOWN) → different root published or incoherent
      state. Returns STALE with ROOT_CHANGED + CONCURRENT_UPDATE note
      (ROOT_CHANGED), or FAILED/PERSIST_FAILURE (ROOT_IDENTITY_UNKNOWN).
  The re-read happens on the same already-open connection (no reconnect).
- **Premark no longer writes "Index publication in progress"**
  (`STATE-R165-01`, P1/P2): R157–R164 wrote the transitory message
  `'Index publication in progress'` to `last_index_error` via the premark
  UPSERT. R164-03's CASE WHEN in `updateProjectStats` preserves
  `last_index_error` when the run is stale AND the new error is NULL —
  so a stale run with `indexError=null` would PRESERVE the transitory
  message as the FINAL state. Graph Status would then show "Index
  publication in progress" indefinitely for a project whose last run was
  actually a stale no-op. R165 simply omits `last_index_error` from the
  premark UPSERT (both the main-path premark and the deletion-only-path
  premark). The column is left at its prior value; the final
  `updateProjectStats` / `commitAliasStateAtomically` call writes the
  real error (or NULL on success).
- **Strengthened `hasPublishedSnapshot`** (`API-R165-01`, P1/P2): R164's
  `hasPublishedSnapshot` (which drives the `publishedSnapshotPreserved`
  field on `IndexResult`) checked only `projectState !== undefined` +
  `EXISTS nodes` + `EXISTS file_hashes`. This was too weak — a stale run
  that had NOT yet been re-indexed (`cross_file_calls_stale=1`) or a
  partial DB whose projects row never advanced `last_successful_index_at`
  would falsely report `publishedSnapshotPreserved=true`. R165 adds two
  conditions:
    - `projectState.lastSuccessfulIndexAt !== null` (and `!== undefined`)
    - `projectState.stale === 0`
  The `last_successful_index_at` column is now read by the `projectState`
  SELECT (was missing in R164).
- **Conditional `preservedSnapshot`** (`API-R165-03`, P2): R163/R164 set
  `preservedSnapshot: true` unconditionally on both root-change early
  returns. But `preservedSnapshot=true` means "structural data exists and
  was not modified" — if `hasExistingGraphData` is false (all six
  structural tables empty), the value should be `false`. R165 changes
  `preservedSnapshot: true` to `preservedSnapshot: hasExistingGraphData`
  in all 4 places (2 STALE + 2 FAILED returns across both early returns).
- **PERSIST_FAILURE recovery is `'none'`** (`OUTCOME-R165-01`, P1/P2):
  R164's FAILED/PERSIST_FAILURE returns set `recovery: 'full_reindex'`.
  But a `full_reindex` recommendation when the DB write itself failed is
  circular — the user must fix the DB issue (SQLITE_BUSY, disk full,
  page corruption) FIRST, then retry. R165 changes `recovery: 'full_reindex'`
  to `recovery: 'none'` in both PERSIST_FAILURE returns. The STALE returns
  (stalePersisted=true) still use `recovery: 'full_reindex'`.
- **Capture SQLite exception message** (`OBS-R165-02`, P2): R164's catch
  block swallowed the SQLite exception. The FAILED/PERSIST_FAILURE
  return's `failure.message` was just `Could not persist stale state:
  ${rootMsg}` — the actual SQLite error was lost. R165 captures the
  message via `persistFailureMsg` and includes it in `failure.message`:
  `Could not persist stale state: ${rootMsg} [DB error: ${persistFailureMsg}]`.

### Known limitations (R165, carried over)

- **No cross-process alias_history lock**: concurrent indexers on the same
  project could race on the alias_history table. This is the same race
  window as the rest of the SQLite write path (mitigated by `busy_timeout`).
- **Full publication non-atomic** (carryover P1): a crash after
  `clearProjectData` but before extraction completes leaves a partial graph.
  Future round will implement `project.db.next` + atomic rename.
- **DB dialect divergence** (carryover P1): V1 uses `rel_path`/`sha256`,
  V2 uses `file_path`/`content_hash`. Future round will add
  `GraphDbDialect` detection.
- **ROOT_CHANGED concurrent-published-current-root re-read is a single
  query** (new, R165): the re-read happens BETWEEN the CAS UPDATE and the
  return — both run on the same already-open connection, so no extra
  reconnect is needed. But the re-read is itself a single SELECT, which
  can race with another concurrent indexer. The race window is small
  (microseconds), and the consequence of a race is conservatively-correct
  (we'd report `concurrentUpdate=true` instead of
  `concurrentPublishedCurrentRoot=true`, returning STALE with a
  CONCURRENT_UPDATE note instead of "Concurrent indexer published this
  root successfully" — both are STALE returns, neither marks the fresh
  snapshot stale). A future round could use a transaction or a single
  UPSERT-RETURNING statement to make the re-read atomic with the CAS.

## R164 — Verified Refusal State + Snapshot Contract

R164 (round 89) closes the 5 confirmed code findings of the R163 audit:

- **Verified root refusal state** (`STATE-R164-01`, P1/P2): R163's two
  root-change early returns (`ROOT_CHANGED` and `ROOT_IDENTITY_UNKNOWN`)
  wrapped the trust-state UPDATE in a try/catch that swallowed ALL
  exceptions. If the UPDATE threw (SQLITE_BUSY under contention, disk
  full, page corruption), the catch set `stalePersisted=false` and the
  early return still returned `outcome='STALE'`. The DB stayed
  `cross_file_calls_stale=0` while the `IndexResult` claimed
  `crossFileCallsStale=true` and `outcome='STALE'`. R164 distinguishes
  the "UPDATE threw" path (return `FAILED` with `PERSIST_FAILURE`) from
  the "UPDATE succeeded" path (return `STALE`). Both root-change early
  returns now set a `persistFailure` flag in the catch; when true, the
  return is `outcome='FAILED'` with `failure.code='PERSIST_FAILURE'`,
  `failure.phase='root-refusal-state'`, and `staleReason` carrying the
  root-change code so consumers can still see the underlying cause. The
  `preservedSnapshot=true` flag is also set on the FAILED return — the
  early return did NOT mutate structural graph data, so the prior
  snapshot (if any) is intact.
- **Check `info.changes`** (`STATE-R164-02`, P1/P2): R163 set
  `stalePersisted = true` unconditionally after `.run()` returned. But
  `better-sqlite3`'s `RunResult.changes` reports the number of rows
  actually written; if the projects row doesn't exist (partial DB with
  structural data but no projects metadata), the UPDATE matches 0 rows,
  `info.changes === 0`, but `stalePersisted` was still `true`. R164 sets
  `stalePersisted = info.changes === 1`. For the `ROOT_IDENTITY_UNKNOWN`
  early return, `info.changes === 0` is treated as a `PERSIST_FAILURE`
  (the projects row is gone or a concurrent indexer populated
  `root_fingerprint` — either way we can't confirm the refusal was
  recorded). For the `ROOT_CHANGED` early return, `info.changes === 0`
  is treated as a concurrent update (see CONC-R164-01).
- **Compare-and-swap on fingerprint** (`CONC-R164-01`, P1/P2): R163 read
  `projectState.rootFingerprint` at the start of the run, then ran the
  trust-state UPDATE later. Between the read and the UPDATE, another
  indexer could `commitAliasStateAtomically` (publishing a fresh snapshot
  under a new `root_fingerprint`). The stale UPDATE would then mark the
  fresh snapshot as stale — `cross_file_calls_stale=1` — even though the
  new snapshot was coherent and fresh. R164 adds a CAS WHERE condition:
    - `ROOT_CHANGED`: `WHERE name = ? AND root_fingerprint = ?` (the
      expected fingerprint is `publishedRootFingerprint` — what we just
      read). If `info.changes === 0`, the fingerprint changed between
      our read and write — we don't mark the (possibly fresh) snapshot
      stale. Return STALE with a CONCURRENT_UPDATE note (NOT FAILED —
      the other indexer may have published successfully).
    - `ROOT_IDENTITY_UNKNOWN`: `WHERE name = ? AND root_fingerprint IS
      NULL`. If `info.changes === 0`, either the projects row is gone
      (no metadata despite structural data — partial DB) OR another
      indexer populated `root_fingerprint` (concurrent publish). Both
      are treated as `PERSIST_FAILURE` (we can't distinguish the two
      cases without an extra query, and a missing-row case means the
      projects metadata is incoherent with the structural graph data —
      a FAILED return is safer than a silent STALE).
- **Preserve `last_index_error` on stale runs** (`STATE-R164-03`, P2):
  R163-02 prevented `last_successful_index_at` from advancing on a stale
  run with no error text. But the UPSERT's
  `last_index_error = excluded.last_index_error` still CLEARED the prior
  error when `indexError=null` was passed (the deletion-only path's
  "previously stale" no-error scenario). Graph Status, which reads
  `last_index_error` for diagnostics, would then show "no error" for a
  project that was stale with a prior diagnostic — the diagnostic was
  lost. R164 changes the clause to a CASE WHEN: when the run is stale
  (`excluded.cross_file_calls_stale=1`) AND the new error is NULL,
  preserve the prior `last_index_error`. Otherwise (success, or stale
  with a new error message), use the new value. The success path
  (`commitAliasStateAtomically`) still uses the unconditional
  `last_index_error = excluded.last_index_error` — R164 only changed
  `updateProjectStats` (the stale/failed path).
- **`publishedSnapshotPreserved` flag** (`API-R164-01`, P1/P2): R163
  added `preservedSnapshot=true` to signal that a previous snapshot
  exists in the DB. But on a partial DB (e.g., an interrupted full index
  after `clearProjectData` deleted `nodes` and `file_hashes` but before
  deleting `edges`), `preservedSnapshot=true` is misleading — there's no
  coherent published snapshot to query. R164 adds a new
  `publishedSnapshotPreserved?: boolean` field to `IndexResult`:
    - `preservedSnapshot=true` — structural data exists (nodes, edges,
      file_hashes, call_sites, imports, OR exports) and was not modified
      by the early return. Does NOT guarantee a coherent published
      snapshot.
    - `publishedSnapshotPreserved=true` — the DB contains a complete,
      coherent snapshot from a previous successful run (nodes AND
      file_hashes AND projects row).
  Both flags are set on both root-change early returns. Consumers that
  need to know whether the DB has a queryable snapshot should check
  `publishedSnapshotPreserved`, not `preservedSnapshot`.

### Known limitations (R164, carried over)

- **No cross-process alias_history lock**: concurrent indexers on the same
  project could race on the alias_history table. This is the same race
  window as the rest of the SQLite write path (mitigated by `busy_timeout`).
- **Full publication non-atomic** (carryover P1): a crash after
  `clearProjectData` but before extraction completes leaves a partial graph.
  Future round will implement `project.db.next` + atomic rename.
- **DB dialect divergence** (carryover P1): V1 uses `rel_path`/`sha256`,
  V2 uses `file_path`/`content_hash`. Future round will add
  `GraphDbDialect` detection.
- **ROOT_CHANGED concurrent update is detected but not retried** (new, R164):
  when `info.changes === 0` on the ROOT_CHANGED CAS, the early return
  gives up and returns STALE with a CONCURRENT_UPDATE note. A future round
  may re-read `projectState` and retry the CAS once, or fall through to
  the no-op path (which would then detect the fresh publication and
  short-circuit). The current behavior is conservative: the caller sees
  STALE + the warning, and can retry.

## R163 — Atomic Refusal State + Success Predicate

R163 (round 88) closes the 5 confirmed code findings of the R162 audit:

- **Atomic root refusal state** (`STATE-R163-01`, P1/P2): R162's two
  root-change early returns (`ROOT_CHANGED` and `ROOT_IDENTITY_UNKNOWN`)
  called `db.close()` first, then `markProjectStalePreservingGraph(dbPath,
  ...)` which opened a *new* connection. If the reopen failed (DB locked,
  corrupt, disk full), the catch block swallowed the error, returned
  `stalePersisted=false`, and the indexer ignored the return value — the
  DB stayed `cross_file_calls_stale=0` while the `IndexResult` claimed
  `crossFileCallsStale=true` and `outcome='STALE'`. Graph Status would
  then report the project as fresh, and a subsequent incremental would
  treat the (still-fresh) graph as a valid baseline for cross-root
  fast-skip. R163 inlines the `UPDATE projects SET cross_file_calls_stale
  = 1, last_index_attempt_at = ?, last_index_error = ?` on the
  ALREADY-OPEN connection, BEFORE `db.close()`. The try/catch sets a
  `stalePersisted` flag; when `false`, the STALE return's
  `staleReason.message` gets a `[WARNING: stale flag could not be
  persisted to DB]` suffix so consumers can detect the inconsistency.
- **Success predicate** (`STATE-R163-02`, P1/P2): R162's
  `updateProjectStats()` used `succeeded = indexError === null`. But
  `crossFileCallsStale` can be true with `indexError=null` — in the
  deletion-only path, when `existingStale=true`, `semanticsStale=false`,
  `hasUncertainty=false`, `crossFileResolved=false`, and
  `callSitesInitialized=true`, the code computes `crossFileStale=true`
  but `deletionError=null`. The success predicate would then advance
  `last_successful_index_at = now` and clear `last_index_error`, masking
  the stale state from Graph Status. R163 changes the predicate to
  `succeeded = indexError === null && !crossFileCallsStale`. When
  `crossFileCallsStale=true`, the run is NOT a success even without
  error text — `last_successful_index_at` is preserved (the CASE WHEN
  clause passes NULL when succeeded=false).
- **Expand `hasExistingGraphData`** (`ROOT-R163-02`, P2): R162's
  `hasExistingGraphData` was a 2-table EXISTS check (`nodes` ∪
  `file_hashes`). A partial DB produced by an interrupted full index
  (after `clearProjectData` deleted `nodes` but before it deleted
  `edges`, or vice versa) would have `hasExistingGraphData=false` even
  though structural graph data is present. The `rootIdentityUnknown`
  gate would then NOT fire, the premark UPSERT would create a fresh
  projects row, and the index would proceed as if no prior snapshot
  existed. R163 expands the EXISTS check to all six structural tables:
  `nodes`, `file_hashes`, `edges`, `call_sites`, `imports`, `exports`.
- **Clarify "no mutation"** (`COMP-R163-01`, P2): R162's documentation
  claimed the root-change early returns perform "no mutation". This was
  inaccurate — `markProjectStalePreservingGraph` writes trust-state
  columns AND calls `clearCrossFileCallEdges` on semantics mismatch (a
  structural mutation). R163 replaces the helper call with an inline
  UPDATE that writes ONLY the three trust-state columns. The comments on
  both early returns now explicitly distinguish "trust-state mutations"
  (which DO happen) from "structural graph mutations" (which do NOT).
  The semantics-mismatch edge clear is removed entirely — a root change
  is not a semantics mismatch.
- **`preservedSnapshot` flag** (`API-R163-01`, P2): R162's two
  root-change early returns set `nodes: 0, edges: 0` in the
  IndexResult. The values are accurate (the run did not extract or
  publish anything), but they're ambiguous: a consumer that interprets
  `nodes=0` as "the graph is empty" would display "no code has been
  indexed for this project" even though the DB has thousands of
  preserved nodes. R163 adds a `preservedSnapshot?: boolean` field to
  `IndexResult`. When `true`, the IndexResult's `nodes=0`/`edges=0`
  reflect "no new work published this run", NOT "graph empty" — a
  previous snapshot still exists in the DB. Consumers that need the
  actual graph size should query the DB. The flag is set on both
  root-change early returns; future rounds may set it on additional
  early-return paths.

### Known limitations (R163, carried over)

- **No cross-process alias_history lock**: concurrent indexers on the same
  project could race on the alias_history table. This is the same race
  window as the rest of the SQLite write path (mitigated by `busy_timeout`).
- **Full publication non-atomic** (carryover P1): a crash after
  `clearProjectData` but before extraction completes leaves a partial graph.
  Future round will implement `project.db.next` + atomic rename.
- **DB dialect divergence** (carryover P1): V1 uses `rel_path`/`sha256`,
  V2 uses `file_path`/`content_hash`. Future round will add
  `GraphDbDialect` detection.
- **Stale-without-error still clears `last_index_error`** (closed in R164):
  R163-02 prevented `last_successful_index_at` from advancing on a stale
  run with no error text, but `last_index_error = excluded.last_index_error`
  in the UPSERT still cleared the prior error when `indexError=null` was
  passed. R164-03 adds a CASE WHEN to preserve the prior error text in
  this case (see R164 section above).

## R162 — Root Change Early Refusal + Legacy Lock

R162 (round 87) closes the 6 confirmed code findings of the R161 audit:

- **Root change EARLY REFUSAL** (`DATA-R162-01` + `RES-R162-01` +
  `STATE-R162-02`, P1): R161's root snapshot identity lock set
  `semanticsStale = rootChanged || existingSemanticsVersion !== CURRENT`
  and continued the pipeline. This was supposed to prevent
  `commitAliasStateAtomically` from being called (the success commit
  would overwrite the old graph's `root_fingerprint`). But it had three
  bugs:
  - **No-op path**: `semanticsStale=true` made `clearCrossFileCallEdges`
    run in the no-op transaction, silently deleting root A's cross-file
    CALLS edges from the graph.
  - **Deletion-only path**: `crossFileStale=true` prevented the success
    commit, but the cleanup transaction still ran, deleting root A's
    nodes/edges/hashes for the "deleted" files (which were root B's
    deletions, not root A's).
  - **Main path**: extraction ran against root B's files, inserting
    root B nodes/edges into a graph that still had root A's other data.
  - Additionally, the no-op path's `noOpError` picked the
    `semanticsStale` branch, logging "Semantics version 8 ≠ current 8"
    even though the REAL cause was a root change and the version
    actually matched.
  R162 replaces this with an EARLY RETURN: after computing `rootChanged`,
  if true, immediately return STALE WITHOUT any mutation. The early return
  is placed BEFORE the premark UPSERT, `clearProjectData`, the contribution
  filter, `statSync` estimation, `deletedRelPaths` computation, the no-op
  path, the deletion-only path, and the main path. The graph, root_path,
  root_fingerprint, and all metadata are preserved. The early return calls
  `db.close()` + `markProjectStalePreservingGraph` (best-effort persist
  `cross_file_calls_stale=1` + `last_index_error`), then returns STALE
  with `staleReason.code = 'ROOT_CHANGED'`, `recovery: 'full_reindex'`,
  `paths: []`, `totalPaths: 0`, `pathsTruncated: false`. `rootChanged`
  is removed from the `semanticsStale` computation (the early return means
  it's never true here). The classifier's `if (params.rootChanged)`
  branch is REMOVED (dead code — the early return handles ROOT_CHANGED
  directly). The `rootChanged` param is retained on the classifier
  signature for backward compatibility (callers still pass it, always
  false in practice).
- **Legacy root bootstrap lock** (`ROOT-R162-01`, P1): R161 treated NULL
  `root_fingerprint` as "no published snapshot to compare against" →
  `rootChanged=false`, preserving the R154 cold-start behavior for legacy
  DBs. But a legacy DB (pre-R154, upgraded to R161+) with existing graph
  data and NULL `root_fingerprint` cannot be trusted for cross-root
  incremental — a root change with preserved metadata would fast-skip all
  files and certify the old graph as fresh. R162 adds a new
  `rootIdentityUnknown = opts.incremental && publishedRootFingerprint
  === null && hasExistingGraphData` check after the `rootChanged` early
  return. When true, returns STALE with `staleReason.code =
  'ROOT_IDENTITY_UNKNOWN'`, `recovery: 'full_reindex'`. The check is
  conservative — it fires for ANY incremental with NULL fingerprint +
  existing graph data, including a same-root incremental. Without a
  published fingerprint, we cannot verify the root identity, so we cannot
  trust the existing graph for incremental mode. The user must run a full
  reindex to establish the `root_fingerprint` baseline. `hasExistingGraphData`
  is the hoisted EXISTS check (`EXISTS(SELECT 1 FROM nodes) ||
  EXISTS(SELECT 1 FROM file_hashes)`) — previously a local variable inside
  the cold-start lock's conditional, now computed unconditionally so the
  R162 check can reuse it.
- **Preserve root_path on stale runs** (`STATE-R162-01`, P1): R161's
  `updateProjectStats` UPSERT's `ON CONFLICT DO UPDATE SET root_path =
  excluded.root_path` unconditionally. This meant a stale run would
  overwrite the published `root_path` with the attempted root, creating
  a contradiction (`root_path=B` while `root_fingerprint=A`). R162
  changes the clause to `root_path = CASE WHEN
  excluded.last_successful_index_at IS NOT NULL THEN excluded.root_path
  ELSE root_path END`. The CASE preserves the published `root_path` when
  `last_successful_index_at` is NULL (i.e., the run is stale/failed). On
  success, `root_path` is updated to the new value.
  `commitAliasStateAtomically` (the success-only path) is unchanged.
- **Test coverage** (`TEST-R162-01`, P1): R161's tests verified that
  `crossFileCallsStale=true` and `staleReason.code='ROOT_CHANGED'` but
  did NOT verify that the graph itself was unchanged. R162 adds
  `tests/indexer/r162-root-early-refusal.test.ts` (21 tests) covering
  no-op preservation, deletion-only preservation, main preservation,
  legacy NULL cross-root, legacy NULL same-root (conservative), legacy
  NULL with no existing data (not refused), full reindex from new root,
  stale no-op preserves root_path, plus 12 source-inspection regression
  guards.

### Correction to the R161 narrative

R161's documentation (CHANGELOG, V2_CURRENT_STATE.md) claimed that the
root snapshot identity lock "refuses incremental" when the root
fingerprint changes. This was inaccurate — R161 did NOT actually refuse
incremental. It set `semanticsStale=true` and continued the pipeline,
which prevented the success commit but allowed mutations:
- No-op path cleared cross-file CALLS edges.
- Deletion-only path deleted root A's data for "deleted" files.
- Main path inserted root B data into root A's graph.

R162 is the first round that ACTUALLY refuses incremental via an early
return. The R161 section above has been left as-is for historical
context; the R162 section is the authoritative description of the
current behavior.

## R161 — Root Snapshot Identity Lock

R161 (round 86) closes the 4 confirmed code findings of the R160 audit:

- **Root snapshot identity lock** (`ROOT-R161-01`, P1 CRITICAL): R160's
  `projectState` query only read `stale`/`initialized`/`version`. The
  root fingerprint (already computed for alias_history scoping) was never
  compared with the published snapshot's `root_fingerprint` column. A
  root change with preserved metadata (same relative paths, mtime_ns,
  size — e.g. `mv project project-moved` followed by an incremental)
  would fast-skip all files via the mtime_ns/size hash check, the no-op
  path would return SUCCESS, and `commitAliasStateAtomically` would
  overwrite the old graph's `root_fingerprint` with the new root's
  fingerprint — silently rebinding the graph to a different physical
  root. The user would see "indexed successfully" while the nodes/edges
  still belonged to the old root. R161 adds:
  - `projectState` query now reads `root_fingerprint AS rootFingerprint`.
  - New `rootChanged = opts.incremental && publishedRootFingerprint !==
    null && publishedRootFingerprint !== rootFingerprint` check.
  - When `rootChanged` is true, `semanticsStale` is forced to true. This
    makes `noOpStale` true (no-op path), `crossFileStale` true
    (deletion-only path), and `crossFileStale` true (main path) —
    preventing `commitAliasStateAtomically` from being called.
  - New `ROOT_CHANGED` code added to the `staleReason.code` union. The
    classifier checks `rootChanged` FIRST (before cold-start lock) — a
    root change makes every other diagnosis moot.
  - `recovery: 'full_reindex'` (the only safe recovery — the graph
    belongs to a different physical root).
  - NULL `root_fingerprint` (pre-R154 DB) → `rootChanged=false`,
    preserving the R154 cold-start behavior for legacy DBs.
  - Full mode is unaffected (rootChanged requires `opts.incremental`).
- **Historical alias path precision** (`API-R161-02`, P1/P2): R160's
  classifier accepted a single `brokenAliasPaths` param used for both
  `COLD_START_LOCK` and `HISTORICAL_ALIAS_BROKEN`. But
  `HISTORICAL_ALIAS_BROKEN` should only surface the EFFECTIVE historical
  aliases (those whose targets are genuinely absent after the R154
  visibility filter). R161 adds a separate `historicalBrokenAliasPaths`
  param; `HISTORICAL_ALIAS_BROKEN` uses it. `COLD_START_LOCK` still uses
  `brokenAliasPaths` (all broken — every broken alias is suspect when
  history is uninitialized). All three callers (no-op, deletion-only,
  main) now pass BOTH lists.
- **Fast-path totalPaths/pathsTruncated** (`OBS-R161-01`, P2): R159
  added `totalPaths` + `pathsTruncated` to the `staleReason` type but
  only the hand-rolled full-uncertainty return set them. The classifier
  (used by the no-op, deletion-only, and main paths) silently omitted
  them, so consumers couldn't display "(showing 100 of N)" for
  fast-path staleReasons. R161 unifies the contract: the classifier's
  `cap()` helper now returns `{ paths, totalPaths, pathsTruncated }`;
  the classifier return type includes the metadata; all three callers
  pass it through to the `staleReason` field.
- **Unified MAX_STALE_PATHS** (`OBS-R161-03`, P2): R160 had
  `const MAX_STALE_PATHS = 100` declared twice (inside the classifier's
  `cap()` and inside the full-uncertainty builder). R161 hoists to a
  single module-level constant so there is one source of truth.

## R160 — Full Orchestrator Failure Taxonomy

R160 (round 85) closes the 8 confirmed code findings of the R159 audit:

- **Expanded failure code taxonomy** (`API-R160-03`): the `failure.code`
  type union was expanded from
  `'PERSIST_FAILURE' | 'EXTRACTION_CRASH' | 'DB_ERROR' | 'UNKNOWN'` to
  `'ROOT_ERROR' | 'DISCOVERY_ERROR' | 'DISCOVERY_PARTIAL' | 'DB_ERROR' |
  'RESOLVER_ERROR' | 'EXTRACTION_CRASH' | 'PERSIST_FAILURE' | 'UNKNOWN'`.
  Each early FAILED path now uses the correct code (ROOT_ERROR for root
  validation, DISCOVERY_ERROR for discovery throw, DISCOVERY_PARTIAL for
  incomplete discovery). DB_ERROR is now reserved for actual DB operation
  failures (the outer catch's cleanup/totals/publish phases).
- **Recovery per phase** (`OUTCOME-R160-01`): root failure and discovery
  failure now recommend `fix_filesystem` (was `retry_incremental` — retrying
  won't help when the root is missing). The outer catch in full mode now
  recommends `full_reindex` (was `retry_incremental` — the graph may be
  partially mutated by clearProjectData followed by a crash, so a full
  reindex is the safe recovery). Incremental outer catch remains
  `retry_incremental` (the existing graph is preserved).
- **Dry-run partial FAILED carries `failure`** (`API-R160-02`): R159's
  dry-run return called `computeOutcome(...)` with `aborted=true`, so a
  dry-run with discovery errors returned `outcome: 'FAILED'` but no
  `failure` field. R160 attaches `failure: { code: 'DISCOVERY_PARTIAL',
  phase: 'dry-run-discovery-partial' }` and `recovery: 'fix_filesystem'`.
- **Phase tracking in outer catch** (`API-R160-04`): R159's outer catch
  always returned `EXTRACTION_CRASH` regardless of which phase crashed.
  R160 adds a `currentPhase` variable (`preload | extraction | cleanup |
  totals | publish`) and maps it to the failure code: preload/extraction →
  `EXTRACTION_CRASH`, cleanup/totals/publish → `DB_ERROR`. The phase is
  embedded in `failure.phase` as `main-path-<phase>` for fine-grained
  triage.
- **Premark no longer updates root_path** (`STATE-R160-02`): R158's
  premark UPSERT set `root_path = excluded.root_path`, but the premark
  represents an ATTEMPTED root, not a confirmed snapshot root. If the
  premark updated root_path and the index then failed, the DB would
  record the attempted (possibly broken) root as the project's root_path.
  R160 removes `root_path = excluded.root_path` from both premark UPSERT
  blocks; root_path is now updated only by the final commit on success.
- **CLI banner: "system error" not "0 errors"** (`CLI-R160-01`): R159's
  PARTIAL/FAILED banner always printed "indexed with N error(s)" first,
  even when `result.failure` was present (N=0 for system failures). R160
  prints "indexing failed due to a system error" when `result.failure`
  is present, followed by the structured failure block.
- **Classifier surfaces paths** (`OBS-R160-01`): R159's
  `classifyStaleReason` did not accept or return paths. The no-op,
  deletion-only, and main paths hardcoded `paths: []` even when the
  staleReason was `HISTORICAL_ALIAS_BROKEN` or `COLD_START_LOCK`. R160
  adds `brokenAliasPaths`, `uncertainPathsList`, `uncertainSubtreesList`
  params to the classifier; the three callers now pass these and use the
  classifier's returned `paths` (capped at 100).

## Current versions

| Component | Version | Source of truth |
|---|---|---|
| Package | see `v2/package.json` | `v2/package.json` |
| Extractor semantics | 8 | `v2/src/indexer/schema.ts` `CURRENT_EXTRACTOR_SEMANTICS_VERSION` |
| Discovery policy | 2 | `v2/src/indexer/schema.ts` `CURRENT_DISCOVERY_POLICY_VERSION` |
| Bugs fixed | see `v2/CHANGELOG.md` | `v2/CHANGELOG.md` |
| Indexer tests | see `v2/CHANGELOG.md` | `v2/CHANGELOG.md` |
| Project tests | see `v2/CHANGELOG.md` | `v2/CHANGELOG.md` |
| Node.js | ≥18.6.0 (engines) | `v2/package.json` |
| Tested on | Node 22/24, Linux | CI + local |

Do NOT hardcode version numbers or test counts in documentation — always reference the authoritative sources above.

## Stable features

### Native indexer (V2 WASM)
- 112 languages via pre-built tree-sitter WASM grammars
- Cross-file CALLS resolution: persistent `call_sites`, `imports`, `exports` tables; resolver matches call-sites to definitions
- Module validity lock: duplicate exports, default marker collisions, unresolved star sources, invalid builtins
- Type/value default separation: `interface`/`type alias` defaults excluded from runtime count
- Builtin truth lock: `isBuiltin()` from `node:module`; `node:fake` rejected, `node:test` accepted
- Incremental indexing: content hash + mtime_ns fast-skip; deletion-only fast path
- Parallel workers: multi-threaded WASM parsing for >20 changed files
- Semantics versioning: incremental forces full reindex when extractor output changes
- Discovery completeness lock: `DiscoveryResult` with structured errors; partial discovery preserves graph
- Canonical root propagation: symlinked roots produce `file_path` without `..`
- File identity contract: `dev:ino` dedup with `0:0` fallback; deterministic hardlink selection
- Persistent discovery state: `cross_file_calls_stale` and `extractor_semantics_version` persisted in DB; Graph Status reads them

### Human memory layer
- 11 node types (ADR, BugNote, RefactorPlan, Convention, LegacyNote, RiskNote, etc.)
- Obsidian-compatible Markdown vault sync (bidirectional, `## HUMAN NOTES` preserved)
- FTS5 full-text search (BM25 ranking)
- Graph UI (2D d3-force, dashboard, filters, WebSocket)
- 7 MCP tools (including flagship `prepare_edit_context`)
- Reports: hotspots, undocumented, risk
- Backup: export/import JSON

### Security
- Path traversal protection (`assertPathInsideRoot` with `path.relative` containment)
- Root discovery validation (`assertDiscoveryRoot`: stat + isDirectory + realpath + readdir)
- Discovery completeness lock (partial discovery preserves graph)
- Stale flag persistence (root failure + partial discovery persist `cross_file_calls_stale=1`)
- Backup rotation (max 5 `.bak` per note)
- Dry-run on sync/export/import/backup

## Limitations

- V2 native indexer is most precise on **TypeScript/JavaScript**. Other languages are parsed structurally without cross-file resolution.
- For full 158-language precision, use V1 C binary as fallback.
- Graph UI capped at ~2000 nodes for performance.
- CI runs on Ubuntu/Node 20 only (no Windows/macOS matrix yet).
- No lockfile committed (dependency versions may drift).
- Full index publication is not atomic (DATA-CARRY-01, P1 — open).

## Blockers (open carryovers)

| ID | Priority | Summary |
|---|---|---|
| DATA-CARRY-01 | P1 | Full index publication not atomic (clear → discover → extract; crash mid-way loses graph) |
| IDX-CARRY-01 | P1 | String-literal export names (`export { foo as "default" }`) not handled |
| IDX-CARRY-02 | P1 | Interface default exports in type namespace clauses |
| IDX-CARRY-03 | P1 | Module requests (non-star imports/re-exports) not validated globally |
| PKG-CARRY-01 | P1 | No lockfile, no CI matrix, no Docker smoke test |
| SEC-CARRY-01 | P2 | TOCTOU: path strings between check and usage |

## Roadmap (next rounds)

- **R144** — Deterministic file identity (multi-extension contract, collision detection)
- **R145** — Atomic full publication (`project.db.next` → validate → atomic rename)
- **R146** — Type namespace + module requests (IDX-CARRY-01/02/03)
- **R147** — CI multi-OS / Node matrix / lockfile (PKG-CARRY-01)
- **R148** — Performance caches / benchmarks (resolver cache, discovery benchmark)

## Workflow Git (hybrid)

```
GitHub HTTPS  →  clone / history (fast)
GitLab SSH    →  push / MR (deploy key)
git -C <abs>  →  bash loses CWD between calls
timeout       →  paramiko wrapper for SSH
SHA verify    →  local SHA = remote SHA after push
```

See [MAINTAINERS_GUIDE.md](../MAINTAINERS_GUIDE.md) for the full workflow.

## Validation date

This document was validated at R164 (2026-07-12). Always cross-check with `v2/CHANGELOG.md` for the latest state.
