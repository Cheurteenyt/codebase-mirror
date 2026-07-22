# External AI Audit Report

> Create a new report for every audited SHA. After import into Git, this file
> is immutable. Resolution state belongs in `docs/ai/CURRENT_HANDOFF.md`.

## Metadata

```yaml
schema_version: 1
kind: audit
round: R000
audit_sequence: A01
repository: Cheurteenyt/Ariad
branch: v2/r000-short-name
base_sha: 0000000000000000000000000000000000000000
audited_sha: 0000000000000000000000000000000000000000
created_at_utc: 1970-01-01T00:00:00Z
auditor_role: external-web-auditor
status: immutable-snapshot
```

## Scope

- Components inspected:
- Contracts and invariants:
- Threat or failure model:
- Explicitly out of scope:

## Repository evidence

Record the commands or repository views used to establish the target. Do not
include credentials, private paths, or unredacted environment data.

```text
git rev-parse HEAD:
git status --short --branch:
git diff --stat <base_sha>..<audited_sha>:
tests or CI inspected:
```

## Verdict

Choose one and explain it:

- `BLOCKING_FINDINGS`
- `NON_BLOCKING_FINDINGS`
- `NO_FINDINGS`
- `INCOMPLETE_AUDIT`

## Findings

Use one subsection per finding. IDs never change after publication.

### R000-A01-F001 — Short actionable title

- **Severity:** `P0 | P1 | P2 | P3`
- **Location:** `path/to/file.ext:line` or stable symbol
- **Evidence:** Reproducible code path, command, or behavioral observation
- **Impact:** Concrete failure or risk
- **Expected behavior:** Exact contract after correction
- **Required regression test:** Test that fails when the correction is reverted
- **Scope constraint:** What must remain unchanged

Duplicate the subsection for each additional finding.

The identifier combines round, audit sequence, and an immutable finding
number. Severity remains a separate field because it may be reassessed later.

## Verified non-findings

List important suspected problems that were checked and not reproduced. This
prevents the implementation agent from repeating already disproved work.

## Residual risks and unknowns

- Missing environment capability:
- Test not executed:
- Assumption requiring maintainer confirmation:

## Recommended validation

```bash
# Exact commands recommended for the implementation agent and CI.
```

## Auditor declaration

- I audited the exact `audited_sha` above.
- I did not modify repository files.
- I did not inspect or request private credentials.
- I did not claim GitHub Actions success without a run on the exact SHA.
