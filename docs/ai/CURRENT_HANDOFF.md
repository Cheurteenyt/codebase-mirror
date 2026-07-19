# Implementation Handoff

## Cycle metadata

```yaml
schema_version: 1
kind: implementation-handoff
round: R171
status: ACTIVE
repository: Cheurteenyt/codebase-mirror
branch: v2/r171-exact-lookup
base_sha: 52a2dbb4745f29a6c353a5537079546140cbe4e3
last_completed_code_sha: 6f1cb935e7adbc58dbd02a5f6e491fd279741b1f
active_audit: NONE
active_audit_blob_oid: NONE
updated_at_utc: 2026-07-19T23:17:45Z
implementer_role: codex
```

## Contracts and non-goals

### Contracts that must remain true

- Product/version contract: preserve all seven existing MCP tool names and
  input/output contracts; add at most one narrow lookup tool.
- Data-format contract: indexed `start_line`/`end_line` remain 1-based and
  existing graph/database formats remain readable without migration.
- Security or durability contract: the new tool is read-only, project-root
  confined, bounded, deterministic, and does not follow evidence outside the
  indexed repository.
- Compatibility contract: Windows and Linux MCP/package behavior remain
  supported; Graph UI, atomic publication, and indexer performance are outside
  this round and must not change.

### Explicit non-goals

- No Graph UI changes.
- No atomic-publication or indexing-performance changes.
- No new broad composite search, shell proxy, regex engine, or write-capable
  MCP surface.
- No claim of success until the exact 12-task benchmark is rerun with native
  token counts and appended to `docs/BENCHMARK_PROTOCOL.md`.

## Audit decisions and root cause

The source is the executed benchmark in `docs/BENCHMARK_PROTOCOL.md`, anchored
to target `5915e0624ed4376611fdc1f824d1d65a327c4a2f`.

| Finding | Source | Decision | Root cause / evidence | Resolution code commit | Regression test | CI-validated head | Validation state |
|---------|--------|----------|-----------------------|------------------------|-----------------|-------------------|------------------|
| R171-BENCH-F001 | T06 | ACCEPTED | **Root cause recorded before correction:** `search_code_and_memory` calls `CodeGraphReader.searchCode`, whose FTS/LIKE inputs are indexed node `name`, `qualified_name`, and file path metadata—not source-file text. T06 searches string literals (`Dependency atlas:` and `exact cross-domain relations`), which are not code nodes. The other allowed tools return module/edit graph context, not arbitrary source occurrences. A zero-result query therefore leaves no permitted exact-text operation and the agent retries variants/contexts, producing the observed 70-call loop and wrong guessed lines. | `6f1cb935e7adbc58dbd02a5f6e491fd279741b1f` | `tests/mcp/exact-source-lookup.test.ts` | pending | LOCAL_PASS |
| R171-BENCH-F002 | T07/T08 | ACCEPTED | **Exact-target audit, before correction:** a fresh full index of `5915e06` stored all relevant locations correctly and 1-based: `routeLayout` 631, `buildDependencyAtlas` 366, `packGraphCircles` 23; `call_sites` stored `listArchitectureDomainDependencies` at 651 and the `routeLayout` route-table call at 140. The route table has anonymous nodes at every line 140-150 but no `Route` nodes. Cross-file resolution reads `call_sites` without its `line` column, edge properties omit call-site lines, and existing MCP context payloads expose definition/neighbor lines but not exact source occurrences. Thus `650` and `142` were agent guesses from incomplete/ambiguous payloads, not an indexer off-by-one or corrupt source location. No line-convention/data correction is warranted; the bounded exact lookup in F003 supplies the missing evidence without changing existing contracts. | `6f1cb935e7adbc58dbd02a5f6e491fd279741b1f` | `tests/mcp/exact-source-lookup.test.ts` | pending | LOCAL_PASS |
| R171-BENCH-F003 | T05/T06 | ACCEPTED | Added one read-only `lookup_source_text` operation: 1-10 unique case-sensitive single-line literals, graph-owned paths only, canonical root/symlink confinement, 1-based path/line/column plus bounded line text, explicit incomplete-scan reasons, and hard file/byte/result caps. The seven prior names/contracts are unchanged. | `6f1cb935e7adbc58dbd02a5f6e491fd279741b1f` | `tests/mcp/exact-source-lookup.test.ts`; `tests/mcp/server.test.ts` | pending | LOCAL_PASS |

## Pushed checkpoints

| Code SHA | CI head SHA | Findings | Summary | Local validation | GitHub run |
|----------|-------------|----------|---------|------------------|------------|
| `52a2dbb4745f29a6c353a5537079546140cbe4e3` | pending | R171-BENCH-F001..F003 | Baseline and T06 root cause recorded before product edits | `git status`, source inspection | pending |
| `6f1cb935e7adbc58dbd02a5f6e491fd279741b1f` | pending | R171-BENCH-F001..F003 | Exact lookup, confinement/bounds, version 0.78.0-alpha.1, and user-facing reference updates | targeted 42 tests, typecheck, build, package build, exact-target MCP smoke | pending |

## Exact validation evidence

```text
command: npx vitest run tests/mcp/exact-source-lookup.test.ts tests/mcp/server.test.ts tests/bridge/sqlite-ro.test.ts
working_directory: v2
environment: Windows 11 / Node.js 24.15.0
exit_code: 0
result_summary: 3 files, 42 tests passed

command: npm run typecheck
working_directory: v2
exit_code: 0
result_summary: backend and Graph UI lab TypeScript checks passed

command: npm run build:package
working_directory: v2
exit_code: 0
result_summary: Graph UI install/build/bundle budgets, backend compile, embedded UI copy and asset verification passed

command: node dist/cli/index.js index --project benchmark-codebase-mirror-5915e06 --root D:\\benchmark\\codebase-mirror-5915e06
working_directory: repository root
exit_code: 0
result_summary: exact target 5915e06; 512 files, 10,665 nodes, 19,597 edges, 0 errors

command: one initialized MCP lookup_source_text call with ten T05-T08 literals
working_directory: v2
exit_code: 0
result_summary: 512 files / 8,910,101 bytes, scan_complete=true; returned the five exact constants, T06 production lines 3689/1035, T07 call line 651, and T08 route entry 140 plus definition/call evidence

command: npm test
working_directory: v2
exit_code: 1
result_summary: 1,525 passed / 534 failed across 152 files; failures are outside this change and reproduce unsupported Windows assumptions (`chmod`, `ls`, `2>/dev/null`, Unix mode checks, extensionless node_modules/.bin/tsx) plus resulting EPERM/timeout cascades. The affected exact-lookup/MCP/reader tests pass. Linux CI remains the broad-suite gate.

not_run: exact 12-task post-fix agent benchmark; GitHub CI still pending
```

## Reset recovery

```bash
REPOSITORY=https://github.com/Cheurteenyt/codebase-mirror.git
WORK_BRANCH=v2/r171-exact-lookup

git clone --single-branch --branch "$WORK_BRANCH" "$REPOSITORY" codebase-mirror
cd codebase-mirror
git fetch origin main "$WORK_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$WORK_BRANCH")"
git merge-base --is-ancestor 52a2dbb4745f29a6c353a5537079546140cbe4e3 HEAD
cd v2
npm ci
```

### First smoke command after reset

```bash
npx vitest run tests/mcp/exact-source-lookup.test.ts
```

## Current working state

- **Last completed finding:** R171-BENCH-F003 bounded exact-source lookup,
  targeted regressions, version/docs, and exact-target smoke.
- **Current finding:** exact 12-task post-fix benchmark and CI evidence.
- **Dirty files expected:** `docs/ai/CURRENT_HANDOFF.md` until this checkpoint.
- **Unpushed commits expected:** `0` before first checkpoint.
- **Known blocker:** none.
- **Single next action:** verify the pushed product checkpoint in GitHub CI,
  then run the exact alternating 12-task MCP/grep benchmark without reruns.

## Security confirmation

- [x] No private key, token, secret path, or runner address is present.
- [x] The implementation agent has no GitLab mirror credential.
- [x] No ephemeral GitHub key was replaced in this round.
- [x] No new host key was accepted in this round.

## Pre-final-audit checklist

- [ ] Every finding has a decision and evidence.
- [ ] Every accepted finding has a pushed resolution commit.
- [ ] Regression tests fail if their corrections are reverted.
- [ ] The full affordable local suite is recorded above.
- [ ] GitHub Actions is green on the candidate SHA.
- [ ] No important work exists only in the current environment.
- [ ] The handoff is ready to archive under `docs/history/round-reports/`.
