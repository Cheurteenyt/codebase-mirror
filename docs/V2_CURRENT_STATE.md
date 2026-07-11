# V2 Current State — Codebase Memory V2

> **Authoritative snapshot of the current product state.** Updated R155 (2026-07-11).
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

This document was validated at R143 (2026-07-11). Always cross-check with `v2/CHANGELOG.md` for the latest state.
