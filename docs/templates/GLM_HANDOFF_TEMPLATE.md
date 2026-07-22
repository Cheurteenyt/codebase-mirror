# Implementation Handoff

> Copy this file to `docs/ai/CURRENT_HANDOFF.md` on the active work branch.
> Update and push it at every checkpoint. Do not store its own containing
> commit SHA; derive the branch head from GitHub during recovery.

## Cycle metadata

```yaml
schema_version: 1
kind: implementation-handoff
round: R000
status: ACTIVE
repository: Cheurteenyt/Ariad
branch: v2/r000-short-name
base_sha: 0000000000000000000000000000000000000000
last_completed_code_sha: REPLACE_WITH_BASE_SHA
active_audit: NONE
active_audit_blob_oid: NONE
updated_at_utc: 1970-01-01T00:00:00Z
implementer_role: glm
```

Valid cycle states: `ACTIVE`, `BLOCKED`, `READY_FOR_FINAL_AUDIT`, `MERGED`.
Before the first code commit, set `last_completed_code_sha` to the exact
`base_sha`. Replace it with each later code checkpoint SHA.
`active_audit` and `active_audit_blob_oid` remain `NONE` until the first
external audit is imported in its own commit.

## Contracts and non-goals

### Contracts that must remain true

- Product/version contract:
- Data-format contract:
- Security or durability contract:
- Compatibility contract:

### Explicit non-goals

-

## Audit decisions

The imported audit is immutable. Record all implementation decisions here.

| Finding | Audit source | Decision | Evidence or reason | Resolution code commit | Regression test | CI-validated head | Validation state |
|---------|--------------|----------|--------------------|------------------------|-----------------|-------------------|------------------|
| R000-A01-F001 | `docs/ai/audits/R000/AUDIT-A01-0000000.md` | ACCEPTED | | | | | NOT_STARTED |

Allowed decisions: `ACCEPTED`, `REJECTED`, `DEFERRED`.

Allowed validation states:

- `NOT_STARTED`
- `DECLARED_LOCAL`
- `IMPLEMENTED_PUSHED`
- `CI_VERIFIED`

Never use `CI_VERIFIED` without a successful GitHub Actions run on the exact
recorded head SHA. That head must contain the resolution commit, and any diff
between them must be limited to handoff or audit documentation.

## Pushed checkpoints

| Code SHA | CI head SHA | Findings | Summary | Local validation | GitHub run |
|----------|-------------|----------|---------|------------------|------------|
| `0000000000000000000000000000000000000000` | pending | R000-A01-F001 | | DECLARED_LOCAL | pending |

`Code SHA` identifies the implementation commit immediately before its
handoff-only commit. The current branch head is always resolved from GitHub.
Verify the imported audit identity with:

```bash
git rev-parse "HEAD:docs/ai/audits/R000/AUDIT-A01-0000000.md"
```

When `active_audit` is not `NONE`, the result must equal
`active_audit_blob_oid`.

## Exact validation evidence

Do not write only "tests pass". Record command, environment, result, and any
timeout or skipped test.

```text
command:
working_directory:
environment:
exit_code:
result_summary:
not_run:
```

## Reset recovery

```bash
REPOSITORY=https://github.com/Cheurteenyt/Ariad.git
WORK_BRANCH=v2/r000-short-name

git clone --single-branch --branch "$WORK_BRANCH" "$REPOSITORY" Ariad
cd Ariad
git fetch origin main "$WORK_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$WORK_BRANCH")"
git status --short --branch

# Replace with last_completed_code_sha from this document.
git merge-base --is-ancestor REPLACE_WITH_LAST_COMPLETED_CODE_SHA HEAD

cd v2
npm ci
```

### First smoke command after reset

```bash
# One narrow command that proves the environment can resume safely.
```

## Current working state

- **Last completed finding:**
- **Current finding:**
- **Dirty files expected:** `NONE` at a pushed checkpoint
- **Unpushed commits expected:** `0` at a pushed checkpoint
- **Known blocker:**
- **Single next action:**

## Security confirmation

- [ ] No private key, token, secret path, or runner address is present.
- [ ] The implementation agent has no GitLab mirror credential.
- [ ] Any replaced ephemeral GitHub key has been reported for revocation.
- [ ] `known_hosts` was verified through a separate trusted channel.

## Pre-final-audit checklist

- [ ] Every finding has a decision and evidence.
- [ ] Every accepted finding has a pushed resolution commit.
- [ ] Regression tests fail if their corrections are reverted.
- [ ] The full affordable local suite is recorded above.
- [ ] GitHub Actions is green on the candidate SHA.
- [ ] No important work exists only in the current environment.
- [ ] The handoff is ready to archive under `docs/history/round-reports/`.
