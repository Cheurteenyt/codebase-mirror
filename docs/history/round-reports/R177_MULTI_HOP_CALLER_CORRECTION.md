# R177 multi-hop caller correction handoff

## Cycle metadata

```yaml
schema_version: 1
kind: implementation-handoff
round: R177
status: COMPLETE
repository: Cheurteenyt/codebase-mirror
branch: v2/r177-multihop-callers
base_sha: 29101436e64113815b5a8223ab0a4b1e7bab3ebb
last_completed_code_sha: e4834d7b3f1a95d3616d71cafed4a8b493659d2b
active_audit: NONE
active_audit_blob_oid: NONE
updated_at_utc: 2026-07-21T21:34:49Z
implementer_role: codex
```

## Contracts and non-goals

### Contracts that must remain true

- Product/version contract: preserve the existing seven read-only MCP tools
  plus `prepare_edit_context`; do not add a tool.
- Data-format contract: preserve existing MCP request and response contracts
  unless the reproduced root cause proves that no narrower internal change or
  optional parameter can fix multi-hop caller traversal.
- Benchmark contract: use the pinned r176 small and large targets, the
  pre-registered TypeScript-oracle answers, both usage modes, and the existing
  `scripts/benchmark/v1-v2-truth-audit/` pipeline.
- Scope contract: change only reverse multi-hop caller resolution and protect
  direct exhaustive/negative callers and shared-type impact from regressions.

### Explicit non-goals

- Graph UI work.
- Atomic publication work.
- Re-running or changing the unrelated T02-T04 task categories.
- Completing any imaginary T05-T08 tasks: the pre-registration contains eight
  target-scoped task objects named `small/T01-T04` and `large/T01-T04`.

## Audit decisions

| Finding | Audit source | Decision | Evidence or reason | Resolution code commit | Regression test | CI-validated head | Validation state |
|---------|--------------|----------|--------------------|------------------------|-----------------|-------------------|------------------|
| R177-B01-F001 | `docs/performance/benchmarks/structural-correctness-baseline-2026-07-21/per-task.md` | CI_VERIFIED | r176 records V2 PARTIAL for both `small/T01` modes and FAIL for both `large/T01` modes; final bounded rerun records 4/4 exact PASS with one call per cell | `e4834d7b3f1a95d3616d71cafed4a8b493659d2b` | `v2/tests/mcp/exact-source-lookup.test.ts` | `65f009d95eceae96f1c8c76b2b619d4d9a8ccd8a` | CI_PASS |

## Root-cause diagnosis recorded before product changes

The r176 failure is reproduced against both pinned V2 databases with the
published `lookup_source_text` MCP operation. The responsible call path is:

```text
LookupSourceTextTool.handle
  -> LookupSourceTextTool.handleDirectCallers
  -> CodeGraphReader.listDirectCallers
```

`prepare_edit_context` is not the transitive implementation: it obtains one
bounded `CALLS` neighbor set with `getBulkNeighbors(..., "both", 50,
"CALLS")`. `get_module_context` likewise performs one
`getNeighbors(..., "both", maxNodes + 1)` query. Neither tool appeared in the
small T01 traces, and neither exposes a reverse multi-hop traversal.
`lookup_source_text.call_chain` does traverse, but in the opposite direction:
it finds one shortest route/CLI-entry-to-terminal chain and cannot enumerate
all reverse callers of a known symbol.

The exact mechanism is the combination of an absent transitive caller
operation and three lossy properties of repeated `direct_callers` calls:

1. `listDirectCallers` reads only `call_sites WHERE last_segment = ?`.
   Intra-file calls are resolved directly to `CALLS` edges by the indexer and
   are not persisted in `call_sites`. The tool can consequently return
   `complete: true` with zero callers even when an exact incoming intra-file
   edge exists.
2. The SQL predicate is a bare symbol-name match. Once a traversal reaches an
   overloaded name such as `clearCache` or `runTests`, call sites for unrelated
   declarations are pooled. The response reports `target_ambiguous`, but gives
   the agent no target identity with which to continue the correct branch.
3. Anonymous callback ownership is normalized only by removing trailing
   `anonymous#N` segments. A variable-assigned arrow such as
   `finalizeMembership` is indexed as file-level `anonymous#19`, so the direct
   response collapses it to the file instead of returning the named callable.

Concrete pinned-source evidence:

- Small: `direct_callers(buildDependencyAtlas)` and
  `direct_callers(getExactScopeMembership)` both reproduce
  `callers: [], complete: true`. SQLite nevertheless contains exact intra-file
  edges `routeLayout::anonymous#41 -> buildDependencyAtlas` and
  `getExactScopePage -> getExactScopeMembership`. The persisted call at
  `sqlite-ro.ts:1043` is owned by file-level `anonymous#19`, which hides the
  independently verified `finalizeMembership` declaration.
- Large: `direct_callers(_innerRunTests)` reproduces
  `callers: [], complete: true`, while SQLite contains the intra-file edge from
  the callback inside `TestRunner.runTests`. `direct_callers(clearCache)`
  returns ten target candidates and mixes `createClearCacheTask`, `opts`,
  `setStorageState`, and a test caller rather than following the specific
  `TestRunner.clearCache` declaration reached at depth one.

This is not an agent early-stop or configured depth-cap failure. Both small
cells issued seven `direct_callers` calls; the large cells issued 30 and 16 MCP
calls respectively and continued with literal source recovery. The false
zero/ambiguous per-hop results are the limiting evidence. The narrow fix must
therefore provide one identity-aware reverse traversal behind the existing
tool, while retaining the depth-one default so T02-T04 and existing direct
caller behavior are not changed.

## Implemented correction

Commit `9bcb3a65b9ba6bb2949e03120a512ff7d454bbfc` adds an optional
`max_depth` parameter to the existing `lookup_source_text.direct_callers`
operation. Depth one follows the old database-backed path and preserves its
response byte-for-byte. Depths two through eight lazily load an independently
bounded TypeScript semantic analysis, resolve the exact graph-selected target
declaration, and walk reverse call identities breadth-first. The result
includes deterministic `transitive_callers` and copy-ready
`formatted_callers`; it excludes repository tests by default while retaining
production directories such as `src/mcp/test`.

The semantic path fixes all three reproduced loss mechanisms without changing
the indexer, the seven-tool product contract, forward `call_chain`, or
unrelated lookup modes. Its runtime dependency is explicit, its source scan is
confined to graph-owned paths under the canonical repository root, and its
file-count, per-file, and total-byte budgets fail closed through incomplete
reasons. The TypeScript compiler module is dynamically imported only when
`max_depth > 1`, so ordinary MCP startup and all depth-one requests retain the
prior loading cost.

Final code commit `e4834d7b3f1a95d3616d71cafed4a8b493659d2b`
also applies the existing `max_callers` ceiling to transitive output and marks
truncation incomplete. This closes the post-measure response-size risk without
changing the 8- and 23-caller oracle results; a fresh final-candidate run is
pre-registered because the response schema bytes nevertheless changed.

## Pushed checkpoints

| Code SHA | CI head SHA | Findings | Summary | Local validation | GitHub run |
|----------|-------------|----------|---------|------------------|------------|
| `29101436e64113815b5a8223ab0a4b1e7bab3ebb` | pending | R177-B01-F001 | Initialize a bounded R177 diagnosis and resolve the apparent T05-T08 corpus gap | corpus and artifact inventory verified locally | pending |
| `9bcb3a65b9ba6bb2949e03120a512ff7d454bbfc` | pending | R177-B01-F001 | Add identity-aware reverse multi-hop traversal behind optional `direct_callers.max_depth` while preserving the depth-one contract | targeted regression 13/13, MCP suite 44/44, typecheck, backend build, pinned small 8/8 and large 23/23 oracle smoke | pending |
| `53e9bc5cbbd442e9c51c5d7a3237802684199798` | pending | R177-B01-F001 | Pre-register the exact four-cell T01 correction round and permit only first-turn T01 filtering in continuous mode | docs check, runner syntax, Codex/checkouts/environment verification | pending |
| `e4834d7b3f1a95d3616d71cafed4a8b493659d2b` | pending | R177-B01-F001 | Bound transitive output with `max_callers`, fail closed on truncation, and pre-register a fresh final-candidate rerun in `c35b9c190575c98d9fa7e93ca81f33527ee566f2` | targeted regression 13/13, MCP suite 44/44, typecheck, backend build, docs check | pending |
| `e4834d7b3f1a95d3616d71cafed4a8b493659d2b` | `65f009d95eceae96f1c8c76b2b619d4d9a8ccd8a` | R177-B01-F001 | Publish the fresh bounded-candidate 4/4 PASS checkpoint in `b635c8496f8e9ae62df99847f872ea6c990826ac` | final oracle verify, 4/4 valid agent cells, package build, docs check | CI `29870317405`; CodeQL `29870317391` |

## Exact validation evidence

```text
command: inspect pre-registration 0f943970..., selected-runs.csv, and r176 .meta.json inventory
working_directory: D:/Mycodex/codebase-mirror
environment: Windows PowerShell, Node.js repository checkout
exit_code: 0
result_summary: eight pre-registered target/task objects and 32/32 expected B/C one-shot/continuous artifacts; no T05-T08 identifiers ever existed
not_run: product tests and benchmark replay are pending root-cause diagnosis
```

```text
command: invoke lookup_source_text.direct_callers through cbm-v2 MCP with the pinned r176 XDG cache; compare call_sites and CALLS rows read-only in SQLite
working_directory: D:/Mycodex/codebase-mirror/v2
environment: Windows PowerShell, XDG_CACHE_HOME=D:/Mycodex/benchmark-state/v2-r173-final
exit_code: 0
result_summary: reproduced false-complete empty intra-file hops on both targets, bare-name ambiguity on Playwright, and anonymous-owner loss for finalizeMembership
not_run: no product code or regression test has been written yet
```

```text
command: npx vitest run tests/mcp/exact-source-lookup.test.ts; npm run typecheck; npm run build; npx vitest run tests/mcp
working_directory: D:/Mycodex/codebase-mirror/v2
environment: Windows PowerShell, Node.js repository checkout
exit_code: 0
result_summary: targeted regression 13/13, MCP tests 44/44, TypeScript typecheck and backend build all pass
not_run: exact four-cell agent benchmark, package build, and GitHub CI remain pending
```

```text
command: invoke updated source MCP direct_callers(max_depth=5, include_tests=false) against the pinned small and large r176 databases
working_directory: D:/Mycodex/codebase-mirror/v2
environment: Windows PowerShell, XDG_CACHE_HOME=D:/Mycodex/benchmark-state/v2-r173-final
exit_code: 0
result_summary: deterministic semantic output matches all 8/8 small and 23/23 large pre-registered production callers, including intra-file, arrow-function, and overloaded-symbol branches
not_run: this is a mechanism smoke, not the required one-shot/continuous Codex benchmark
```

```text
command: npm run docs:check
working_directory: D:/Mycodex/codebase-mirror/v2
environment: Windows PowerShell, Node.js repository checkout
exit_code: 0
result_summary: documentation validator passes for 58 Markdown files; all 48 required docs are reachable and all 8 structural questions/references match the canonical protocol
not_run: package build and GitHub CI remain pending
```

```text
command: node --check scripts/benchmark/v1-v2-truth-audit/run.mjs; node scripts/benchmark/v1-v2-truth-audit/run.mjs verify --results-root D:/Mycodex/benchmark-results/r177-multihop-callers-final --v2-home D:/Mycodex/benchmark-state/v2-r173-final
working_directory: D:/Mycodex/codebase-mirror
environment: Windows PowerShell, Codex CLI 0.144.4
exit_code: 0
result_summary: runner syntax is valid; both pinned checkouts are clean at their registered SHAs and all benchmark executables/state paths resolve
not_run: no measured process started before pre-registration was committed and pushed
```

```text
command: run and summarize the pre-registered r177 four-cell postfix phase; publish checkpoint multihop-caller-correction-2026-07-21
working_directory: D:/Mycodex/codebase-mirror
environment: Windows PowerShell, Codex CLI 0.144.4, gpt-5.6-sol medium
exit_code: 0
result_summary: 4/4 valid PASS, one lookup_source_text call per cell, 252680 raw tokens versus 1179045 before; post-measure review retained these artifacts but required a fresh bounded-candidate rerun
not_run: no T02-T04 task was executed
```

```text
command: npx vitest run tests/mcp/exact-source-lookup.test.ts; npm run typecheck; npm run build; npx vitest run tests/mcp; npm run docs:check
working_directory: D:/Mycodex/codebase-mirror/v2
environment: Windows PowerShell, Node.js repository checkout
exit_code: 0
result_summary: bounded-output regression passes including truncation fail-closed behavior; targeted 13/13, MCP 44/44, typecheck, backend build, and documentation checks pass
not_run: fresh final bounded-candidate four-cell run and GitHub CI remain pending
```

```text
command: run, summarize, and checkpoint the pre-registered bounded-final four-cell postfix phase; derive-structural-references.mjs verify --target all --task T01
working_directory: D:/Mycodex/codebase-mirror
environment: Windows PowerShell, Codex CLI 0.144.4, gpt-5.6-sol medium
exit_code: 0
result_summary: 4/4 valid PASS with exact independent-oracle answers, one lookup_source_text call per cell, zero violations, no invalid attempts, and no T02-T04 artifacts; 236935 raw tokens and 4 calls versus 1179045 and 60 before
not_run: GitHub CI remains pending
```

```text
command: npm run build:package
working_directory: D:/Mycodex/codebase-mirror/v2
environment: Windows PowerShell, Node.js repository checkout
exit_code: 0
result_summary: backend compiled, unchanged Graph UI rebuilt within all bundle budgets, embedded assets copied, and complete package is ready for npm pack
not_run: npm publication is outside this round
```

```text
command: npm test
working_directory: D:/Mycodex/codebase-mirror/v2
environment: Windows PowerShell, Node.js repository checkout
exit_code: 1
result_summary: broad suite reaches unrelated POSIX permission and symlink tests that read Windows temporary-directory mode as 0o666 and reject it with STORE_LAYOUT_PERMISSIONS_INSECURE, predominantly in inactive atomic-generation publication; targeted MCP 44/44 remains green
not_run: no out-of-scope atomic-publication or cross-platform test rewrite; authoritative Linux CI is pending
```

```text
command: GitHub Actions CI 29870317405 and CodeQL 29870317391
working_directory: GitHub head 65f009d95eceae96f1c8c76b2b619d4d9a8ccd8a
environment: protected pull-request checks
exit_code: 0
result_summary: backend, Windows smoke, frontend, npm pack/install/CLI, Docker non-root smoke, JavaScript/TypeScript CodeQL, and Python CodeQL all pass on the exact candidate head
not_run: main-branch post-merge CI and GitLab mirror parity remain integration gates
```

## Reset recovery

```bash
REPOSITORY=https://github.com/Cheurteenyt/codebase-mirror.git
WORK_BRANCH=v2/r177-multihop-callers

git clone --single-branch --branch "$WORK_BRANCH" "$REPOSITORY" codebase-mirror
cd codebase-mirror
git fetch origin main "$WORK_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$WORK_BRANCH")"
git status --short --branch
git merge-base --is-ancestor 29101436e64113815b5a8223ab0a4b1e7bab3ebb HEAD

cd v2
npm ci
```

### First smoke command after reset

```bash
node scripts/benchmark/v1-v2-truth-audit/verify-spec.mjs
```

## Current working state

- **Last completed finding:** R177-B01-F001 is CI_VERIFIED on exact head `65f009d95eceae96f1c8c76b2b619d4d9a8ccd8a`.
- **Current finding:** none; the implementation round is complete.
- **Dirty files expected:** only the handoff archive move and documentation-index updates until pushed.
- **Unpushed commits expected:** one trailing documentation-only archive commit.
- **Known blocker:** none.
- **Single next action:** push the archive commit, rerun required checks on its
  exact head, then mark PR #72 ready and squash-merge into protected `main`.

## Security confirmation

- [x] No private key, token, secret path, or runner address is present.
- [x] The implementation agent has no GitLab mirror credential.
- [x] No ephemeral GitHub key was replaced in this round.
- [x] No new SSH host key was accepted in this round.

## Pre-final-audit checklist

- [x] Every finding has a decision and evidence.
- [x] Every accepted finding has a pushed resolution commit.
- [x] Regression tests fail if their corrections are reverted.
- [x] The full affordable local suite is recorded above.
- [x] GitHub Actions is green on the candidate SHA.
- [x] No important work exists only in the current environment.
- [x] The handoff is ready to archive under `docs/history/round-reports/`.
