# R179 T01 stability repetition handoff

## Cycle metadata

```yaml
schema_version: 1
kind: methodology-handoff
round: R179
status: ACTIVE
repository: Cheurteenyt/Ariad
branch: v2/r179-t01-stability
base_sha: 148e4b65849efc3fcfbc4fb716abf0898424293d
last_completed_code_sha: 148e4b65849efc3fcfbc4fb716abf0898424293d
active_audit: NONE
active_audit_blob_oid: NONE
updated_at_utc: 2026-07-22T18:58:13Z
implementer_role: codex
```

## Contracts and non-goals

### Contracts that must remain true

- Product/version contract: no product code change, no new fix, and no new
  benchmark task; repeat only the exact four R178 T01 B/C cells.
- Data-format contract: preserve R178 prompts, policies, questions, TypeScript
  oracle answers, native accounting, mechanical grading, and artifact names.
- Durability contract: pre-registration is pushed before any run; three raw
  roots are append-once and keep repetitions independently auditable.
- Environment contract: disclose OS, runtime, Codex CLI, model, and reasoning
  before every configuration repetition rather than assuming no drift.

### Explicit non-goals

- No reinterpretation of R176-R178, no T02-T04 run, no A/D condition, no Graph
  UI work, no runner modification, and no product or packaging change.
- No rerun because a grade, token count, variance, or ratio is unfavorable.

## Methodology finding

| Finding | Scope | Pre-registered decision | Validation state |
|---------|-------|-------------------------|------------------|
| R179-METH-T01 | 4 configurations × B/C × N=3 | token-stable iff each cell/arm has max/min <= 1.20; grade-stable iff all three grades match; aggregate direction and ratio spread must also hold | pre-registration written; no raw root created |

## Pushed checkpoints

| Code SHA | CI head SHA | Finding | Summary | Local validation | GitHub run |
|----------|-------------|---------|---------|------------------|------------|
| `148e4b65849efc3fcfbc4fb716abf0898424293d` | `148e4b65849efc3fcfbc4fb716abf0898424293d` | R179-INIT | Anchor the no-product methodology round at merged R178 main | clean exact main; prior R178 checkpoint present | prior main CI PASS |

## Exact validation evidence

```text
command: git status --short --branch; git rev-parse HEAD; git rev-parse origin/main
working_directory: repository root
environment: Windows 11, PowerShell
exit_code: 0
result_summary: clean main and origin/main both resolve to 148e4b65849efc3fcfbc4fb716abf0898424293d before branch creation
```

```text
command: Test-Path for each future r179-t01-stability-rep-N raw root
working_directory: D:/Mycodex/benchmark-results
environment: read-only existence check
exit_code: 0
result_summary: all three roots returned False before the pre-registration commit
```

```text
command: npm run docs:check
working_directory: v2
environment: Windows 11, Node.js
exit_code: 0
result_summary: 7 tests passed; 66 Markdown files checked; 56 docs reachable; benchmark questions and reference answers verified
```

## Reset recovery

```bash
REPOSITORY=https://github.com/Cheurteenyt/Ariad.git
WORK_BRANCH=v2/r179-t01-stability

git clone --single-branch --branch "$WORK_BRANCH" "$REPOSITORY" Ariad
cd Ariad
git fetch origin main "$WORK_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$WORK_BRANCH")"
git merge-base --is-ancestor 148e4b65849efc3fcfbc4fb716abf0898424293d HEAD
git status --short --branch

cd v2
npm ci
```

### First smoke command after reset

```powershell
node scripts/benchmark/v1-v2-truth-audit/run.mjs verify `
  --results-root D:/Mycodex/benchmark-results/r179-t01-stability-rep-1 `
  --v2-home D:/Mycodex/benchmark-state/v2-r173-final
```

## Current working state

- **Last completed finding:** R178 is merged and mirrored at `148e4b6`.
- **Current finding:** immutable N=3 T01 stability pre-registration.
- **Dirty files expected:** benchmark protocol, active handoff, and pointer.
- **Unpushed commits expected:** one initialization/pre-registration checkpoint.
- **Known blocker:** none.
- **Single next action:** validate docs, commit and push the pre-registration,
  open a draft PR, then verify green base/branch CI, runner, oracles, and all
  three absent result roots before repetition 1.

## Security confirmation

- [x] No private key, token, secret path, or runner address is present.
- [x] The implementation agent has no GitLab mirror credential.
- [x] No ephemeral GitHub key was replaced in this round.
- [x] No new SSH host trust was established in this round.

## Pre-final-audit checklist

- [ ] Pre-registration is committed and pushed before any measured process.
- [ ] All 24 selected cells are valid or invalid attempts remain disclosed.
- [ ] Every repetition has a full environment row.
- [ ] Per-cell samples, min/max/mean, grades, and calls are published.
- [ ] The 5.166401365x historical point is located against the new range.
- [ ] No important work exists only in the current environment.
- [ ] The handoff is archived and removed before merge.
