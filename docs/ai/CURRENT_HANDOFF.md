# R181 Structural Cost Root-Cause Handoff

## Cycle metadata

```yaml
schema_version: 1
kind: implementation-handoff
round: R181
status: ACTIVE
repository: Cheurteenyt/Ariad
branch: v2/r181-structural-cost-root-cause
base_sha: 93e0d5c99fa5dd09a5276a9c5c7e922b16f64315
last_completed_code_sha: df4298caea146b4a5a1d8cc5a07440e22bd20922
active_audit: NONE
active_audit_blob_oid: NONE
updated_at_utc: 2026-07-23T01:50:08Z
implementer_role: codex
```

## Contracts and non-goals

### Contracts that must remain true

- Product/version contract: preserve every public MCP, CLI, UI, and package contract unless the evidence proves a contract defect.
- Data-format contract: keep the R176 structural task specification, independent oracle, prompts, native accounting, and grading semantics unchanged.
- Security or durability contract: benchmark roots are append-once; invalid artifacts remain disclosed; no credential or private host path enters tracked evidence.
- Compatibility contract: Windows remains supported and benchmark helpers use Node process/path APIs with argument arrays.

### Explicit non-goals

- No change to T01, `direct_callers`, or the R177/R179 multi-hop implementation.
- No new MCP tool and no speculative product optimization unsupported by repeated traces.
- No Graph UI or unrelated documentation redesign in this round.

## Audit decisions

No external audit is active. R181 is an evidence-first root-cause round initiated from the mixed R176 T02-T04 result.

| Finding | Audit source | Decision | Evidence or reason | Resolution code commit | Regression test | CI-validated head | Validation state |
|---------|--------------|----------|--------------------|------------------------|-----------------|-------------------|------------------|
| R181-LOCAL-F001 | R176 T02-T04 single-sample evidence | ACCEPTED | Repeat N=3 and attribute token cost before deciding whether a repository defect exists. | `1ced999a49a647b22fc5e08a6a1d5a50fafc1bbe` | environment helper smoke plus existing mechanical benchmark checks | pending | IMPLEMENTED_PUSHED |
| R181-LOCAL-F002 | R181 N=3 traces and pinned indexes | ACCEPTED | T02 lacks alias-aware type-impact evidence; 10-19 distinct B calls cause 87.5% of the one-shot gap. Add a general bounded operation inside `lookup_source_text`; do not touch T01/direct callers. | `1c151232f1d49042d9e7ecfc3f44987fa5612625` | `tests/mcp/exact-source-lookup.test.ts`; `tests/mcp/server.test.ts` | pending | MEASURED_ACCEPTED_LOCAL |

## Pushed checkpoints

| Code SHA | CI head SHA | Findings | Summary | Local validation | GitHub run |
|----------|-------------|----------|---------|------------------|------------|
| `93e0d5c99fa5dd09a5276a9c5c7e922b16f64315` | pending | R181-LOCAL-F001 | Post-PR #76 clean-main anchor. | `git status`; exact local/origin SHA | pending |
| `1ced999a49a647b22fc5e08a6a1d5a50fafc1bbe` | pending | R181-LOCAL-F001 | N=3 protocol, mechanism/noise gates, and append-once environment capture. | helper syntax/smoke; `git diff --check`; `npm --prefix v2 run docs:check` | pending |
| `6b80e3a36481c69ad397de69297542ae80069ab5` | pending | R181-LOCAL-F001 | Ensure raw manifests hash every pre-registered environment capture. | targeted 2-test checkpoint suite; full `docs:check` (8 tests) | pending |
| `61af45679ad28a4cef7d7888cab04dfdbe07758b` | pending | R181-LOCAL-F001, R181-LOCAL-F002 | Three immutable baseline checkpoints and pre-fix mechanism/noise diagnosis. | 72/72 decision cells valid; `docs:check` (8 tests) | pending |
| `1c151232f1d49042d9e7ecfc3f44987fa5612625` | pending | R181-LOCAL-F002 | Add one bounded alias-aware TypeScript `type_dependents` profile inside the existing `lookup_source_text` tool. | typecheck; build; MCP 47/47; docs check; pinned small 7/7 and large 8/8 oracle smoke | pending |

## Exact validation evidence

```text
command: git status --short --branch; git rev-parse HEAD; git remote -v
working_directory: D:/Mycodex/codebase-mirror
environment: Windows benchmark host
exit_code: 0
result_summary: clean main and origin/main both at 93e0d5c99fa5dd09a5276a9c5c7e922b16f64315; origin is Cheurteenyt/Ariad
not_run: build, oracle verification, and repeated measurements wait for the pushed pre-registration
```

```text
command: node --check scripts/benchmark/v1-v2-truth-audit/capture-environment.mjs; helper smoke to a disposable external file; git diff --check; npm --prefix v2 run docs:check
working_directory: D:/Mycodex/codebase-mirror
environment: Windows 11 Pro 10.0.26200 x64; Node v24.15.0; npm 11.12.1; Codex CLI 0.144.4
exit_code: 0
result_summary: helper captured the full environment and refused overwrite semantics by construction; 7 documentation/benchmark tests passed; 74 Markdown files validated; 8 structural questions matched the protocol
not_run: product build and repeated measurements intentionally wait for remote pre-registration
```

```text
command: npm ci; npm run build
working_directory: D:/Mycodex/codebase-mirror/v2
environment: Windows host while the local V2 MCP process was still using the built native addon
exit_code: 1
result_summary: npm ci could not unlink better_sqlite3.node (EPERM); the following build saw the intentionally incomplete node_modules tree. Process inspection identified PID 30548 as this repository's dist/cli/index.js mcp process; no source failure was inferred.
not_run: no benchmark cell started until the process was stopped and install/build passed
```

```text
command: npm ci; npm run build; runner verify; derive-structural-references.mjs verify --target all --task T02/T03/T04; fixed 24-invocation baseline schedule
working_directory: D:/Mycodex/codebase-mirror (npm commands in v2)
environment: Windows 11 Pro 10.0.26200 x64; Node v24.15.0; npm 11.12.1; Codex CLI 0.144.4; gpt-5.6-sol medium
exit_code: 0 after stopping the local V2 MCP process that held better_sqlite3.node during the first npm ci attempt
result_summary: deterministic install and build passed; both pinned checkouts and all six T02-T04 oracles verified; all 24 baseline invocations and 84 raw cells completed on attempt 1 in 3182.3 seconds
not_run: aggregation and trace diagnosis intentionally waited until the complete schedule finished
```

```text
command: node --test scripts/benchmark/v1-v2-truth-audit/checkpoint.test.mjs; npm --prefix v2 run docs:check
working_directory: D:/Mycodex/codebase-mirror
environment: same disclosed R181 host
exit_code: 0
result_summary: 2 targeted tests and all 8 documentation/benchmark tests pass; raw manifest test proves environment is included and derived output excluded
not_run: raw checkpoints and diagnosis are the next action
```

```text
command: summarize.mjs and checkpoint.mjs for baseline repetitions 1-3; trace/index attribution; npm --prefix v2 run docs:check
working_directory: D:/Mycodex/codebase-mirror
environment: same disclosed R181 host; all raw manifests include the pre-invocation environment records
exit_code: 0
result_summary: 28 selected raw cells per repetition and no invalid cell; only 2/24 token groups stable; old direction pattern rejected; T02 type-impact capability gap published before product changes
not_run: no product correction or postfix cell existed when this diagnosis checkpoint was created
```

```text
command: npm run typecheck; npm run build; npx vitest run tests/mcp; npm run docs:check; invoke type_dependents against both pinned read-only indexes
working_directory: D:/Mycodex/codebase-mirror/v2 (pinned-index smoke launched from repository root)
environment: same disclosed R181 Windows host and immutable small/large checkouts
exit_code: 0
result_summary: typecheck and build pass; all 47 MCP tests pass; all 8 documentation/benchmark tests pass; the new operation returns the exact independent-oracle sets (small 7/7 in 2.5s, large 8/8 in 13.2s) with complete=true; unsafe workspace export targets fail completeness closed
not_run: identical N=3 postfix schedule waits for this correction and handoff checkpoint to be pushed cleanly
```

```text
command: capture 24 postfix environments; execute fixed 24-invocation N=3 B/C schedule; summarize.mjs and checkpoint.mjs for repetitions 1-3; apply pre-registered non-overlapping-range gates; npm --prefix v2 run docs:check
working_directory: D:/Mycodex/codebase-mirror
environment: 24/24 captures agree on clean cd78ae40c4f834d6a1dfdb02c2eabcb688f4f329, Windows host, Node v24.15.0, npm 11.12.1, Codex CLI 0.144.4, gpt-5.6-sol medium
exit_code: 0
result_summary: 24 invocations and 84 raw cells completed on attempt 1 in 2817.9 seconds; 28 selected and 0 invalid per repetition; all four T02 B groups HELPED, no selected B group WORSE; B moves 34 PASS/2 PARTIAL to 36 PASS and 11,575,204 to 5,372,595 tokens; docs/links/oracles pass
not_run: full backend, package, and Graph UI validation plus remote CI wait are the next action
```

## Reset recovery

```bash
REPOSITORY=https://github.com/Cheurteenyt/Ariad.git
WORK_BRANCH=v2/r181-structural-cost-root-cause

git clone --single-branch --branch "$WORK_BRANCH" "$REPOSITORY" Ariad
cd Ariad
git fetch origin main "$WORK_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$WORK_BRANCH")"
git status --short --branch
git merge-base --is-ancestor 93e0d5c99fa5dd09a5276a9c5c7e922b16f64315 HEAD

cd v2
npm ci
```

### First smoke command after reset

```bash
node scripts/benchmark/v1-v2-truth-audit/run.mjs verify --results-root D:/Mycodex/benchmark-results/r181-t02-t04-cost-rep-1
```

## Current working state

- **Last completed finding:** R181-LOCAL-F002 accepted same-N postfix measurement, published locally at `df4298caea146b4a5a1d8cc5a07440e22bd20922`.
- **Current finding:** final local validation and remote candidate verification.
- **Dirty files expected:** `NONE` at the pushed checkpoint.
- **Unpushed commits expected:** `0` after this handoff checkpoint is pushed.
- **Known blocker:** none.
- **Single next action:** push the measurement checkpoint, run the full backend/package/Graph UI validation matrix, then update the candidate handoff for remote CI.

## Security confirmation

- [x] No private key, token, secret path, or runner address is present.
- [x] The implementation agent has no GitLab mirror credential.
- [x] No replaced ephemeral GitHub key needs revocation.
- [x] No new SSH host trust was established.

## Pre-final-audit checklist

- [ ] Every finding has a decision and evidence.
- [ ] Every accepted finding has a pushed resolution commit or an evidence-backed no-fix conclusion.
- [ ] Regression tests fail if an implemented correction is reverted.
- [ ] The full affordable local suite is recorded above.
- [ ] GitHub Actions is green on the candidate SHA.
- [ ] No important work exists only in the current environment.
- [ ] The handoff is ready to archive under `docs/history/round-reports/`.
