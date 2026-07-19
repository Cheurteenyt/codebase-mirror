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
last_completed_code_sha: 52a2dbb4745f29a6c353a5537079546140cbe4e3
active_audit: NONE
active_audit_blob_oid: NONE
updated_at_utc: 2026-07-19T22:59:31Z
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
| R171-BENCH-F001 | T06 | ACCEPTED | **Root cause recorded before correction:** `search_code_and_memory` calls `CodeGraphReader.searchCode`, whose FTS/LIKE inputs are indexed node `name`, `qualified_name`, and file path metadata—not source-file text. T06 searches string literals (`Dependency atlas:` and `exact cross-domain relations`), which are not code nodes. The other allowed tools return module/edit graph context, not arbitrary source occurrences. A zero-result query therefore leaves no permitted exact-text operation and the agent retries variants/contexts, producing the observed 70-call loop and wrong guessed lines. | pending | pending | pending | NOT_STARTED |
| R171-BENCH-F002 | T07/T08 | ACCEPTED | Line convention audit pending. The indexer visibly stores tree-sitter rows as `row + 1`; the remaining question is whether any MCP payload exposes call-site/route-entry lines or whether the agent guessed from definition-only metadata. | pending | pending | pending | NOT_STARTED |
| R171-BENCH-F003 | T05/T06 | ACCEPTED | One bounded exact source occurrence/value lookup is required; existing broad tools and contracts remain unchanged. | pending | pending | pending | NOT_STARTED |

## Pushed checkpoints

| Code SHA | CI head SHA | Findings | Summary | Local validation | GitHub run |
|----------|-------------|----------|---------|------------------|------------|
| `52a2dbb4745f29a6c353a5537079546140cbe4e3` | pending | R171-BENCH-F001..F003 | Baseline and T06 root cause recorded before product edits | `git status`, source inspection | pending |

## Exact validation evidence

```text
command: pending
working_directory: pending
environment: Windows 11 / Node.js (derive exact version at validation)
exit_code: pending
result_summary: pending
not_run: all product tests and post-fix benchmark
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

- **Last completed finding:** T06 root cause documented before correction.
- **Current finding:** R171-BENCH-F002 line-number provenance audit.
- **Dirty files expected:** `docs/ai/CURRENT_HANDOFF.md` until first checkpoint.
- **Unpushed commits expected:** `0` before first checkpoint.
- **Known blocker:** none.
- **Single next action:** trace T07/T08 lines from tree-sitter extraction through
  SQLite and each MCP response, then decide whether a data correction is
  warranted.

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
