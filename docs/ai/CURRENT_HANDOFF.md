# R178 fresh B/C multi-hop confirmation handoff

## Cycle metadata

```yaml
schema_version: 1
kind: implementation-handoff
round: R178
status: ACTIVE
repository: Cheurteenyt/codebase-mirror
branch: v2/r178-fresh-bc-multihop
base_sha: d542d666a048eb14e6b6ca314efd47239cca92e5
last_completed_code_sha: d542d666a048eb14e6b6ca314efd47239cca92e5
active_audit: NONE
active_audit_blob_oid: NONE
updated_at_utc: 2026-07-22T01:50:17.4113114Z
implementer_role: codex
```

## Contracts and non-goals

### Contracts that must remain true

- Product/version contract: measure the exact post-R177 `main` candidate at
  `d542d666a048eb14e6b6ca314efd47239cca92e5`; this round makes no product,
  runner, task, oracle, grading, or dependency change.
- Data-format contract: use the active
  `scripts/benchmark/v1-v2-truth-audit/tasks.json` T01 question and independent
  TypeScript-oracle answer unchanged on both pinned target SHAs.
- Security or durability contract: both arms remain read-only, raw artifacts
  are append-once in a fresh external root, and the pushed pre-registration
  precedes every measured Codex process.
- Compatibility contract: condition B uses only the existing V2 MCP evidence
  policy; condition C uses only grep/read shell evidence; the model, reasoning,
  target checkout, host, runtime, attempt policy, and measurement pipeline are
  held constant within this round.

### Explicit non-goals

- No T02-T04, V1 arm, direct-read arm, Graph UI, product fix, benchmark-runner
  change, broad superiority claim, or reinterpretation of R176/R177.
- No attempt to claim that R176 and R178 used identical OS/runtime/hardware:
  R176 did not record those fields.

## Audit decisions

No external audit is active. R178 is a bounded verification round requested to
replace the cross-round approximately 5.2x token comparison with one fresh
apples-to-apples B/C comparison.

## Pushed checkpoints

| Code SHA | CI head SHA | Findings | Summary | Local validation | GitHub run |
|----------|-------------|----------|---------|------------------|------------|
| `d542d666a048eb14e6b6ca314efd47239cca92e5` | pending | R178-PROTOCOL | Exact environment, R176 environment gap, eight-cell order, immutable roots, and acceptance rules fixed before measurement | `npm run docs:check` PASS | pending |

## Exact validation evidence

```text
command: git status --short --branch; git rev-parse HEAD; git rev-parse origin/main
working_directory: repository root
environment: Microsoft Windows 11 Professionnel 10.0.26200 build 26200, 64 bits
exit_code: 0
result_summary: clean main; local and origin/main both d542d666a048eb14e6b6ca314efd47239cca92e5 before branch creation
not_run: measured benchmark cells are forbidden until this pre-registration is committed and pushed
```

```text
command: inspect every r176 T01 B/C meta JSON and the published raw manifest
working_directory: repository root
environment: PowerShell, read-only artifact inspection
exit_code: 0
result_summary: all eight T01 metadata files record gpt-5.6-sol, medium, codex-cli 0.144.4 and the expected target SHAs; neither metadata nor manifest records OS, Node, npm, CPU, or RAM
not_run: no measured Codex process
```

```text
command: npm run docs:check
working_directory: v2
environment: Node.js v24.15.0, npm 11.12.1, Windows 11
exit_code: 0
result_summary: 7/7 documentation/checkpoint/reference tests pass; 63 Markdown files, 25 active, and 53 reachable; all 24 historical and 8 structural reference answers verified
not_run: measured benchmark cells remain forbidden until push
```

## Reset recovery

```bash
REPOSITORY=https://github.com/Cheurteenyt/codebase-mirror.git
WORK_BRANCH=v2/r178-fresh-bc-multihop

git clone --single-branch --branch "$WORK_BRANCH" "$REPOSITORY" codebase-mirror
cd codebase-mirror
git fetch origin main "$WORK_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$WORK_BRANCH")"
git merge-base --is-ancestor d542d666a048eb14e6b6ca314efd47239cca92e5 HEAD
git status --short --branch
```

### First smoke command after reset

```powershell
node scripts/benchmark/v1-v2-truth-audit/run.mjs verify `
  --results-root D:/Mycodex/benchmark-results/r178-fresh-bc-multihop-final `
  --v2-home D:/Mycodex/benchmark-state/v2-r173-final
```

## Current working state

- **Last completed finding:** R177 multi-hop correction is merged on `main`.
- **Current finding:** R178-PROTOCOL, fresh same-round B/C confirmation.
- **Dirty files expected:** protocol and active-handoff documentation until the
  pre-registration checkpoint is committed.
- **Unpushed commits expected:** 0 before the pre-registration commit.
- **Known blocker:** none.
- **Single next action:** run `npm run docs:check`, commit and push this exact
  pre-registration, then build/verify and execute the four fixed B/C commands.

## Security confirmation

- [x] No private key, token, secret path, or runner address is present.
- [x] The implementation agent has no GitLab mirror credential.
- [x] No ephemeral GitHub key was replaced in this round.
- [x] No new SSH host trust was established in this round.

## Pre-final-audit checklist

- [x] The environment and historical comparison limits are disclosed.
- [x] The exact cells, order, roots, task, candidate, and acceptance rules are
  fixed before measurement.
- [ ] The pre-registration commit is pushed before every measured process.
- [ ] All eight fresh cells are valid and mechanically graded.
- [ ] The canonical checkpoint and plain-language ratio are published.
- [ ] The affordable local validation and GitHub CI are green.
- [ ] The handoff is archived and removed before merge.
