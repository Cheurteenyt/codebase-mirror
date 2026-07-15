# Repository Governance — Codebase Memory V2

> **Status:** current
> **Last verified:** 0.75.0 / R169

This document is the source of truth for GitHub repository settings that
are NOT visible in the Git repository itself. It covers branch protection,
environment configuration, merge policy, security settings, and the
settings freeze protocol.

## 1. Repository Identity

| Property | Value |
|----------|-------|
| Canonical host | GitHub |
| Passive mirror | GitLab |
| Default branch | `main` |
| Repository visibility | Public |

## 2. Ruleset: `protect-main`

| Setting | Value | Rationale |
|---------|-------|-----------|
| Status | Active | Enforced on all pushes to `main` |
| Target | `main` | Only the default branch is protected |
| Admin bypass | Allow for pull requests only | Admins must use PRs, no direct push bypass |
| Restrict deletions | ON | `main` cannot be deleted |
| Restrict creations | OFF | No restriction on branch creation |
| Restrict updates | OFF | No restriction on branch updates |
| Require linear history | ON | No merge commits on `main` (squash-only) |
| Require a pull request | ON | No direct pushes to `main` (except break-glass) |
| Required approvals | 1 | Native human boundary against write-capable branch workflows |
| Dismiss stale approvals | ON | Every new push invalidates the previous approval |
| Require review from teams | OFF | No teams configured |
| Require Code Owners | ON | Root `CODEOWNERS` assigns all paths to `@Cheurteenyt` |
| Require approval of most recent push | OFF | The deploy-key push actor is attributed to the sole owner; stale-review dismissal provides the exact-head boundary |
| Require conversation resolution | ON | All conversations must be resolved before merge |
| Allowed merge method | Squash only | Linear history + clean commit messages |
| Require status checks | ON | CI must pass before merge |
| Required checks | `Backend (v2)`, `Frontend (graph-ui)`, `npm pack + install + CLI smoke`, `Docker build + CLI + non-root smoke` | All four always-run CI jobs must be green |
| Require branches up to date | ON | PR branch must be rebased on latest `main` |
| Block force pushes | ON | No `--force` to `main` |
| Require deployments to succeed | OFF | A `workflow_run` deployment resolves from `main`, not the candidate SHA; it would not add the promised GLM boundary |
| Require signed commits | OFF | Not yet configured |
| Require code scanning | OFF (observe first) | Pinned CodeQL workflow is active but is not a required check until stable |
| Require code quality | OFF (deferred) | Not yet configured |
| Restrict code coverage | OFF (deferred) | Not yet configured |
| Automatic Copilot code review | OFF | Not configured |

### Checks NOT in the ruleset (post-merge or conditional)

| Check | Trigger | Required? | Note |
|-------|---------|-----------|------|
| `Mirror validated main` | `workflow_run` on CI success | No (post-merge) | Runs after merge to main |
| `gitlab-passive-mirror` | Environment deployment | No (post-merge) | Mirror deployment record |
| `Repository Health Report` | Weekly schedule | No | Informational only |
| `CodeQL / Analyze (javascript-typescript)` | PR/main/schedule | No | Observe alerts before making it required |
| `CodeQL / Analyze (python)` | PR/main/schedule | No | Observe alerts before making it required |
| `GLM merge gate` | Successful exact-SHA GLM branch CI | No | Owner-reviewed integration orchestrator, not a status-check bypass |

## 3. Settings → General → Pull Requests

| Setting | Value | Verification |
|---------|-------|-------------|
| Allow squash merging | ON | VERIFIED BY API |
| Allow merge commits | OFF | VERIFIED BY API |
| Allow rebase merging | OFF | VERIFIED BY API |
| Allow auto-merge | ON | VERIFIED BY API |
| Automatically delete head branches | ON | VERIFIED BY API |
| Always suggest updating pull request branches | ON | VERIFIED BY API |

## 4. Settings → General → Archives

| Setting | Value |
|---------|-------|
| Include Git LFS objects in archives | OFF |

The repository does not use Git LFS.

## 5. Settings → General → Push Policy

| Setting | Value |
|---------|-------|
| Limit how many branches and tags can be updated in a single push | ON |
| Limit | 5 |

This rule prevents accidental `git push --mirror` or mass ref updates while
not affecting normal single-branch pushes or mirror operations.

## 6. Settings → Actions → General

| Setting | Expected | Verification |
|---------|----------|-------------|
| Default GITHUB_TOKEN permissions | Read-only | VERIFIED BY API |
| Allow GitHub Actions to create and approve PRs | ON | Required only for the GLM PR broker; Actions bot approval cannot satisfy required Code Owner review |
| Fork PR workflows | Approval required | MANUAL VERIFICATION REQUIRED |
| Actions allowed | All actions, with full-length SHA pinning required | Authenticated GitHub API + workflow audit |
| Artifact/log retention | 7 days | VERIFIED BY API; dependency caches use their independent last-access policy |
| PR workflows created by `GITHUB_TOKEN` | Owner approval required per run | GitHub safety behavior; inspect the exact diff before selecting **Approve workflows to run** |

> **Note:** Verify these settings with an authenticated GitHub API call during
> each governance audit. Settings without API coverage still require a manual
> check in the repository UI.

## 7. Environment: `gitlab-passive-mirror`

| Setting | Value |
|---------|-------|
| Required reviewers | None |
| Wait timer | None |
| Deployment branches | Selected: `main` only |

### Secret (1)

| Name | Description |
|------|-------------|
| `GITLAB_MIRROR_SSH_PRIVATE_KEY` | OpenSSH Ed25519 private key — authenticates GitHub Actions to GitLab. Dedicated to this repo only. Never logged or exposed. |

### Variables (4)

| Name | Description |
|------|-------------|
| `GITLAB_REPOSITORY_SSH_URL` | `git@gitlab.com:cheurteen1/codebase-memory-V2.git` |
| `GITLAB_KNOWN_HOSTS` | Full content of GitLab.com official host keys (not a file path) |
| `GITLAB_MIRROR_KEY_FINGERPRINT` | `SHA256:p45GIFj/WYp6QAab9FgwbC0cgGv4EHPj94I8PKQBO5M` — expected client deploy key fingerprint |
| `GITLAB_ED25519_HOST_FINGERPRINT` | `SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8` — expected GitLab.com host key fingerprint |

**Total: 1 secret + 4 variables = 5 configuration values.**

All deployment records for this environment are preserved as audit history.
Do not delete the environment — it would destroy its secrets and rules.

## 7b. Environment: `glm-merge-gate`

| Setting | Value |
|---------|-------|
| Required reviewer | `Cheurteenyt` |
| Prevent self-review | OFF |
| Administrator bypass | OFF |
| Wait timer | None |
| Deployment branches | Custom policy: exact branch `main` |
| Secrets | None |
| Variables | None |

This environment was created before the workflow reached `main`. It protects
the canonical repository-owned job that squash-merges a qualified GLM pull
request and dispatches exact post-merge checks. The ruleset separately requires
an approval from the base-branch Code Owner and dismisses that approval after
every push. The Actions bot can open the PR but cannot satisfy the Code Owner
rule. See
[GLM_GITHUB_OPERATIONS.md](GLM_GITHUB_OPERATIONS.md).

### 7c. Residual GLM deploy-key boundary

The repository-scoped SSH write key protects credential portability, not API
isolation. A holder can push a branch workflow that explicitly requests wider
ephemeral `GITHUB_TOKEN` permissions; the repository's read-only default is not
a maximum. Consequently, z.ai and the deploy key are trusted for operational
side effects outside `main`. Unexpected cache, run, ref, release, or API
activity requires immediate key revocation and an Actions audit.

The protected-`main` ruleset and exact `@Cheurteenyt` CODEOWNER review prevent
an unreviewed integration. The protected merge environment is an explicit
operator confirmation for the supported automation, but the ruleset does not
make that environment an exclusive merge credential: after exact owner review,
a branch workflow token can attempt the merge API directly. The separate
main-only GitLab environment still prevents mirror-secret access.

A stricter model in which the second confirmation is technically mandatory
requires a separate staging repository or a narrowly permissioned GitHub App
whose identity is pinned in the ruleset. Same-repository SSH alone cannot make
that promise.

## 8. GitLab Contract

| Rule | Status |
|------|--------|
| Branches | `main` only |
| Feature branches | None |
| Merge requests | None |
| CI pipelines | Disabled (`workflow: rules: when never`) |
| Runners | None |
| Force push | Blocked |
| Deploy key | `github-actions-passive-mirror` with write access + authorized on protected `main` |

## 9. Advanced Security

### Active

| Setting | Status | Proof |
|---------|--------|-------|
| Dependabot version updates | DISABLED BY POLICY | `.github/dependabot.yml` sets `open-pull-requests-limit: 0` for every ecosystem so scheduled version PRs do not create persistent branches |
| Dependency graph / vulnerability alerts | ACTIVE | Vulnerability-alert API enabled |
| Dependabot security updates | ACTIVE | Repository security settings API |
| Secret scanning | ACTIVE | Repository security settings API; zero open alerts at last audit |
| Push protection | ACTIVE | Repository security settings API |
| Private vulnerability reporting | ACTIVE | Private-reporting API |
| CodeQL | CONFIGURED | Pinned workflow for JavaScript/TypeScript and Python; first runs must be observed before ruleset promotion |

### Not enabled or not promoted

| Setting | Status | Note |
|---------|--------|------|
| Secret scanning non-provider patterns | OFF | Optional; evaluate after baseline stabilization |
| Secret validity checks | OFF | Optional; evaluate after baseline stabilization |
| CodeQL required-check rule | DEFERRED | Promote only after stable successful runs and exact check names are observed |
| Copilot Autofix | NOT VERIFIED | Evaluate only after CodeQL has produced a stable baseline |

Five Dependabot alerts still referenced versions older than the committed
lockfile during the last audit. Do not dismiss them as fixed until GitHub has
recomputed the dependency graph or the current manifest evidence has been
reviewed again.

Setting `open-pull-requests-limit: 0` disables scheduled version updates only.
Dependabot security updates remain enabled and may create a temporary PR when a
new vulnerable dependency is detected. After the security fix is merged or
closed, branch deletion must return the repository to `main` only.

### Deferred

| Setting | Status | Note |
|---------|--------|------|
| Require code scanning in ruleset | DEFERRED | Wait for CodeQL stability |
| Actions Policies Preview | DEFERRED | Evaluate mode only if used |
| Self-hosted runners | DEFERRED | Public repo — security risk with fork PRs |
| OIDC | DEFERRED | No cloud credentials needed yet |

## 10. Repository Settings Freeze

After validation of the current protected-`main` baseline, repository settings
are **frozen**.

Settings may only be modified for one of the following events:

1. Adding a new stable pre-merge check
2. Adding a second reliable maintainer (increase required approvals)
3. Stable CodeQL activation
4. First release preparation (tag protection ruleset)
5. Adding a release environment
6. Security incident
7. GitHub App / API credential migration
8. Official GitHub policy change

### Change control protocol

Every settings modification must include:

```
- reason
- old value
- new value
- screenshot or API proof
- operational test
- update to REPOSITORY_GOVERNANCE.md
- rollback plan
```

## 11. Merge Contract

The normal workflow for every change:

```
feature/round branch
  → CI triggered by each v2/** checkpoint push; latest SHA green
  → GitHub Pull Request
  → required PR checks: Backend (v2) + Frontend (graph-ui) + package smoke + Docker smoke green
  → exact-head approval from @Cheurteenyt as required Code Owner
  → conversations resolved
  → squash merge
  → branch automatically deleted
  → CI on push/main
  → mirror to GitLab
```

## 12. Break-Glass Procedure

Direct push to `main` is NOT the normal workflow. In an emergency:

1. **Declare an incident** (document the reason)
2. **Document the expected SHA**
3. **Admin temporarily modifies the ruleset** if needed
4. **Non-forced push only** — never `--force` to `main`
5. **Verify CI and mirror** after the push
6. **Re-enable protection immediately**
7. **Add a postmortem entry** to `worklog.md`

## 13. Auto-Merge Rules

Auto-merge is enabled at the repository level but must be used carefully:

- Do NOT activate auto-merge until all four always-run CI jobs are green
- Auto-merge is appropriate only while all four checks remain required
  and stable
- Never use `Merge without waiting for requirements to be met` outside
  a documented break-glass

## 14. Verification Checklist

After any modification to GitHub repository settings:

```
[ ] Ruleset `protect-main` is Active
[ ] Target is `main`
[ ] PR required before merge
[ ] One approval required and dismissed on every push
[ ] Code Owner review required; `* @Cheurteenyt` resolves from base `main`
[ ] Backend + Frontend + Package Smoke + Docker Smoke are required checks
[ ] Squash-only merge
[ ] Force push blocked
[ ] Deletion blocked
[ ] Linear history required
[ ] Conversation resolution required
[ ] Auto-delete head branches ON
[ ] Auto-merge ON (but use carefully)
[ ] Push policy max 5 refs ON
[ ] Environment `gitlab-passive-mirror` restricted to `main`
[ ] Environment `glm-merge-gate` has reviewer `Cheurteenyt`
[ ] `glm-merge-gate` administrator bypass OFF and exact `main` policy
[ ] `glm-merge-gate` has no secret or variable
[ ] Secret `GITLAB_MIRROR_SSH_PRIVATE_KEY` present and non-empty
[ ] Variable `GITLAB_REPOSITORY_SSH_URL` present
[ ] Variable `GITLAB_KNOWN_HOSTS` present
[ ] Variable `GITLAB_MIRROR_KEY_FINGERPRINT` present
[ ] Variable `GITLAB_ED25519_HOST_FINGERPRINT` present
[ ] No self-hosted runners configured
[ ] Dependabot security updates active; scheduled version PR limit remains zero
[ ] Default `GITHUB_TOKEN` permission read-only
[ ] Actions PR creation is enabled only while Code Owner review is required
[ ] Bot-created PR workflow runs are approved only after exact-diff review
[ ] GLM deploy key is treated as a trusted operational principal and revoked on unexpected API activity
[ ] Artifact/log retention is 7 days
[ ] No `pull_request_target` in any workflow without audit
```

## 15. Related Documents

- [GITHUB_GITLAB_BRANCH_BRIDGE.md](GITHUB_GITLAB_BRANCH_BRIDGE.md) — Mirror architecture, postmortem, diagnostic matrix
- [CI_CONTINUITY.md](CI_CONTINUITY.md) — Operational resilience plan
- [RELEASE_POLICY.md](RELEASE_POLICY.md) — Release governance
- [MAINTAINERS_GUIDE.md](../MAINTAINERS_GUIDE.md) — Development workflow and conventions
- [RESTRICTED_ENVIRONMENT_GIT_TRANSPORT.md](RESTRICTED_ENVIRONMENT_GIT_TRANSPORT.md) — SSH wrapper for environments without native OpenSSH
- [GLM_GITHUB_OPERATIONS.md](GLM_GITHUB_OPERATIONS.md) — GLM push, PR brokerage, owner review, and gated squash merge
- [GITHUB_ACTIONS_STORAGE_POLICY.md](GITHUB_ACTIONS_STORAGE_POLICY.md) — Cache quota, retention, and exact-ID cleanup policy

## 16. Cross-host Signature Trust Boundary (SIG-R169)

### Current state: Phase B ACTIVATED

The signature gate is now **active** (Phase B merged). The 2-phase
bootstrap is complete:

- **Phase A (completed):** Verifier script + tests + docs published and
  squash-merged as `f5d42688d921f04b4323a017586af4566c17e381`.
- **Phase B (active):** The mirror workflow loads both the verifier and
  mirror state machine from the current immutable pin shown below. The
  verifier runs before target checkout; the target checkout is thereafter
  treated as Git data only.

```
TRUSTED_VERIFIER_SHA = 15a732d91984e5b4ffa29b4e129ac0d6316c9fca
```

### Rotation procedure

To update the verifier or mirror state machine:
1. Publish a runtime update PR (scripts + tests + docs only; keep the old pin)
2. Squash-merge and verify CI green + mirror green
3. Record the new squash SHA
4. In a separate PR, update both the `TRUSTED_VERIFIER_SHA` environment
   value and the literal trusted-checkout `ref` in
   `.github/workflows/mirror-main-to-gitlab.yml`
5. Update the pin assertions and documented SHA, then verify the pinned blob
   is the runtime exercised by the tests

Never use `main`, `HEAD`, `TARGET_SHA`, `github.sha`, or any moving ref.

### Architecture

GitHub is the **canonical authority** for commit signature verification.

GitLab may display "Unverified" for commits signed by GitHub's `web-flow`
identity because GitLab maintains its own trust registry and does not
automatically reuse GitHub's verification results.

This is **not** a corruption indicator — it means GitLab's local trust
model doesn't recognize the GitHub signing key.

### Trust boundary (SIG-R169-POLICY-01)

The signature gate is a **provenance check**, not a **safety check**.

It protects against:
- Unsigned direct pushes to `main`
- Commits with invalid or malformed signatures
- Cryptographic identities GitHub does not recognize

It does NOT prove:
- Absence of malicious code in the commit
- Sufficiency of human review
- Immutability of the workflow itself
- Absence of account compromise

The verifier and mirror state machine are loaded from an immutable pinned
SHA. No checked-out target code is executed before the gate, and no script
provided by `TARGET_SHA` is executed after the GitLab credential is
materialized. The workflow itself remains protected by repository branch
protection rules, not by the signature gate.

### Canonical source (SIG-R169-DIV-01)

The verification and transport logic live in two canonical scripts:
`scripts/ci/verify-github-commit-signature.sh` and
`scripts/ci/mirror-main-to-gitlab.sh`. The workflow calls their immutable
pinned snapshots directly. Runtime tests execute the published sources;
changes become active only after a separate trusted-pin rotation.

### Trust contract

The mirror workflow verifies, **before** materializing any GitLab SSH
credential:

```text
GitHub API: commit.verification.verified == true
GitHub API: commit.verification.reason == "valid"
GitHub API: commit.verification.verified_at is a valid ISO-8601 timestamp WITH timezone
GitHub API: response.sha == TARGET_SHA
```

If any of these checks fail, the mirror does not proceed. No GitLab
SSH key is written to disk. No push is attempted. GitLab remains at
the last successfully mirrored SHA.

The `verified_at` field follows the real GitHub API contract
(SIG-R4-VERIFYAT-01): it is required (ISO-8601 with timezone) only on
success (`verified=true`, `reason=valid`); on refusal it may be `null`
and is normalized to `""` in the output. The `reason` field is validated
against the official GitHub enum (SIG-R4-PARSER-01).

After successful mirror: `GitLab main SHA == TARGET_SHA` proves the
exact Git object verified by GitHub is now present on GitLab.

### Three verdicts (SIG-R169-Phase-B-CONC, SIG-R169-Phase-B-FINAL, FINAL-INVARIANTS-02)

The mirror workflow has a **final verdict step** (last step, `if: always()`)
that **exits 1 on FAILED**. The job goes red if the effective state is
FAILED, not just if an earlier step failed.

Cleanup runs BEFORE the verdict (`id: cleanup`, `if: always()`). The
verdict requires `steps.cleanup.outcome == success`.

**Common MIRROR_INVARIANTS_OK** (required for SUCCESS and SUPERSEDED):
`POST_VERIFY_RESULT == success`, `CLIENT_FP_VERIFIED == true`,
`HOST_FP_VERIFIED == true`, `ERROR_CATEGORY == none`, `ERROR_PHASE == none`,
`GITHUB_MAIN_SHA` non-empty, `JOB_STATUS == success`, `CLEANUP_OUTCOME == success`.

**Push coherence** per verdict:
- SUCCESS mirrored: `push_attempted=true`, `push_completed=true`
- SUCCESS already-mirrored: `push_attempted=false`, `push_completed=false`
- SUPERSEDED: accepts EITHER `push_attempted=false` + `push_completed=false`
  (PREEXISTING — GitLab was already ahead) OR `push_attempted=true` +
  `push_completed=true` (AFTER_PUSH_RACE — a newer mirror pushed a
  descendant after this run's push). Both are valid operational successes;
  no rollback needed. SUPERSEDED also requires `GITHUB_MAIN_SHA != TARGET_SHA`.

```text
SUCCESS mirrored:         mirrored + exact parity + push true + invariants + sig
SUCCESS already-mirrored: already-mirrored + exact parity + push false + invariants + sig
SUPERSEDED:               newer-valid + parity false + observed != target + push false + invariants + sig
FAILED:                   everything else → exit 1
```

**Exact target parity** (`observed_sha == TARGET_SHA`) is different from
**operational coverage**. SUPERSEDED means GitLab is ahead (a descendant
of TARGET_SHA is already mirrored) — exact parity is false, but the
mirror is operationally valid. The summary displays both separately.

**Runtime verdict tests** (`r169-phase-b-verdict-runtime.test.ts`) extract
the real Bash verdict block from the workflow YAML and execute it with
a complete env matrix — verifying exit code, verdict output, and summary
content for SUCCESS, SUPERSEDED, and all FAILED paths.

### What NOT to do

- Do not add GitHub's `web-flow` GPG key to a GitLab user profile
- Do not pin the GitHub key ID in code or secrets
- Do not enable `Reject unsigned commits` on GitLab (would break mirror)
- Do not rewrite or re-sign commits to get a green GitLab badge
- Do not accept unsigned commits as a fallback

### Break-glass requirement

Break-glass direct pushes to `main` must use a signing identity that
GitHub verifies. An unsigned break-glass push will pass CI but the
mirror will refuse to replicate it to GitLab.

### Script

`scripts/ci/verify-github-commit-signature.sh` is the canonical verifier;
`scripts/ci/mirror-main-to-gitlab.sh` is the canonical mirror state machine.
Phase A: completed (squash-merged as `f5d42688d921f04b4323a017586af4566c17e381`).
Phase B: active — the mirror workflow calls both scripts from the pinned
immutable SHA and never executes the target's copy of the mirror script.
The verifier uses `GITHUB_TOKEN` (no new secrets), retries transient errors
(max 3, backoff 1s/2s), and fails closed on all other errors. Any change to
either published source requires a later, separate pin-rotation PR before it
becomes the production runtime.
