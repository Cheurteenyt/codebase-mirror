# R178 fresh B/C multi-hop confirmation handoff

## Cycle metadata

```yaml
schema_version: 1
kind: implementation-handoff
round: R178
status: ARCHIVED
repository: Cheurteenyt/Ariad
branch: v2/r178-fresh-bc-multihop
base_sha: d542d666a048eb14e6b6ca314efd47239cca92e5
last_completed_code_sha: 432878eb0dbea9d016ef4d43ad20f0792cba1933
active_audit: NONE
active_audit_blob_oid: NONE
updated_at_utc: 2026-07-22T02:31:29.5682657Z
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

### Post-measure repository migration

After the immutable R178 result was pushed, GitHub reported the canonical
repository as `Cheurteenyt/Ariad`. The exact-SHA CI and CodeQL preflights still
required the former repository name and therefore failed before running any
validation. The owner confirmed that the rename was intentional and authorized
the active control-plane, package metadata, and documentation migration to
`Cheurteenyt/Ariad`. This publication fix occurs after all measured processes;
it does not alter the candidate SHA, task, oracle, runner, or raw artifacts.

## Audit decisions

No external audit is active. R178 is a bounded verification round requested to
replace the cross-round approximately 5.2x token comparison with one fresh
apples-to-apples B/C comparison.

## Pushed checkpoints

| Code SHA | CI head SHA | Findings | Summary | Local validation | GitHub run |
|----------|-------------|----------|---------|------------------|------------|
| `d542d666a048eb14e6b6ca314efd47239cca92e5` | `38d10e93d27fc46d13329648d000a9c072d21622` | R178-PROTOCOL | Exact environment, R176 environment gap, eight-cell order, immutable roots, and acceptance rules fixed and pushed before measurement | `npm run docs:check` PASS | pending |
| `d542d666a048eb14e6b6ca314efd47239cca92e5` | `5d5d2e8f2f2fdbc702167e8f1e3ab36bdc7c6957` | R178-RESULT | Eight fresh same-round B/C cells: B 4/4 PASS and 236,837 raw tokens; C 0/4 PASS and 1,223,595; C/B 5.166401365x | build, runner/oracle verify, 8/8 valid cells, immutable checkpoint, docs check, typecheck, benchmark tests, package build | exact-SHA preflight failed because the renamed repository still had the legacy workflow binding |
| `432878eb0dbea9d016ef4d43ad20f0792cba1933` | `432878eb0dbea9d016ef4d43ad20f0792cba1933` | R178-REPOSITORY-MIGRATION | Six sensitive workflows, public metadata, active documentation, and validator migrated to `Cheurteenyt/Ariad`; frozen benchmark evidence preserved | governance/watchdog 28/28, docs 7/7, typecheck, build, package, YAML parse | CI push `29885944993` PASS; CI PR `29885947072` PASS; CodeQL `29885947052` PASS |

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

```text
command: npm run build; run.mjs verify; derive-structural-references.mjs verify --target all --task T01
working_directory: v2 and repository root as applicable
environment: Node.js v24.15.0, Codex CLI 0.144.4, pinned v2-r173-final state
exit_code: 0
result_summary: exact candidate compiles; both target checkouts are clean at registered SHAs; independent TypeScript oracle matches 8/8 small and 23/23 large callers
not_run: no T02-T04 task
```

```text
command: execute the four pre-registered run.mjs B/C invocations; summarize.mjs; checkpoint.mjs
working_directory: repository root
environment: Microsoft Windows 11 Professionnel build 26200, Node.js v24.15.0, npm 11.12.1, Codex CLI 0.144.4, gpt-5.6-sol medium
exit_code: 0
result_summary: 8/8 valid attempt-1 cells with zero violations; B is 4 PASS/0 PARTIAL/0 FAIL and 236837 raw tokens/4 calls; C is 0 PASS/2 PARTIAL/2 FAIL and 1223595 raw tokens/52 calls; fresh C/B is 5.166401365x; 40-artifact tree ed0349cfe9608b960693c77c891f6cda982a7c49dc355b8a801a3446aee181c0
not_run: no attempt 2, no T02-T04, no product modification
```

```text
command: npm run docs:check; npm run typecheck; node --test summarize/checkpoint/derive structural tests; npm run build:package
working_directory: v2 and repository root as applicable
environment: Node.js v24.15.0, npm 11.12.1, Windows 11
exit_code: 0
result_summary: documentation valid for 65 Markdown files with 55 reachable and all references verified; TypeScript backend/lab check passes; 7/7 benchmark tests pass; backend and embedded Graph UI package build passes every bundle budget with npm audit reporting 0 vulnerabilities
not_run: the optional AsyncSSH self-test cannot start because asyncssh==2.24.0 is not installed; the helper passes Python syntax compilation
```

```text
command: npx vitest run tests/ci/r169-glm-github-governance.test.ts tests/ci/r169-glm-post-merge-watchdog-runtime.test.ts; parse all workflow YAML; npm test
working_directory: v2
environment: Node.js v24.15.0, npm 11.12.1, Windows 11
exit_code: targeted tests and YAML parse 0; broad npm test 1
result_summary: 28/28 repository-governance and watchdog-runtime regressions pass, including the canonical Ariad binding across six sensitive workflows. The broad suite reaches unrelated POSIX filesystem tests but fails on Windows permission/symlink emulation, repeatedly reading temporary compatibility roots as mode 0o666; no storage or indexer source is modified by this migration.
not_run: actionlint is not installed locally; mandatory GitHub Actions validates the workflow files and the Linux-specific product suite on the exact pushed SHA
```

## Reset recovery

```bash
REPOSITORY=https://github.com/Cheurteenyt/Ariad.git
WORK_BRANCH=v2/r178-fresh-bc-multihop

git clone --single-branch --branch "$WORK_BRANCH" "$REPOSITORY" Ariad
cd Ariad
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

- **Last completed finding:** R178 fresh B/C confirmation and the canonical
  Ariad repository migration are validated on exact head `432878e`.
- **Current finding:** R178-CLOSED; this record is historical and inactive.
- **Dirty files expected:** none after the archival commit.
- **Unpushed commits expected:** none after the archival commit.
- **Known blocker:** none.
- **Single next action:** require exact CI and CodeQL on the archival head, then
  squash-merge PR #73.

## Security confirmation

- [x] No private key, token, secret path, or runner address is present.
- [x] The implementation agent has no GitLab mirror credential.
- [x] No ephemeral GitHub key was replaced in this round.
- [x] No new SSH host trust was established in this round.

## Pre-final-audit checklist

- [x] The environment and historical comparison limits are disclosed.
- [x] The exact cells, order, roots, task, candidate, and acceptance rules are
  fixed before measurement.
- [x] The pre-registration commit is pushed before every measured process.
- [x] All eight fresh cells are valid and mechanically graded.
- [x] The canonical checkpoint and plain-language ratio are published locally.
- [x] The affordable local validation and GitHub CI are green.
- [x] The handoff is archived and removed before merge.
