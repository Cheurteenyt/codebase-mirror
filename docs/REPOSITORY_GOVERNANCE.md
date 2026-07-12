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
| Required approvals | 0 | Single maintainer; PR + checks still required |
| Dismiss stale approvals | OFF | Not needed with 0 approvals |
| Require review from teams | OFF | No teams configured |
| Require Code Owners | OFF | No CODEOWNERS file yet |
| Require approval of most recent push | OFF | Not needed with 0 approvals |
| Require conversation resolution | ON | All conversations must be resolved before merge |
| Allowed merge method | Squash only | Linear history + clean commit messages |
| Require status checks | ON | CI must pass before merge |
| Required checks | `Backend (v2)`, `Frontend (graph-ui)` | Both CI jobs must be green |
| Require branches up to date | ON | PR branch must be rebased on latest `main` |
| Block force pushes | ON | No `--force` to `main` |
| Require deployments to succeed | OFF | Not needed |
| Require signed commits | OFF | Not yet configured |
| Require code scanning | OFF (deferred) | CodeQL not yet activated |
| Require code quality | OFF (deferred) | Not yet configured |
| Restrict code coverage | OFF (deferred) | Not yet configured |
| Automatic Copilot code review | OFF | Not configured |

### Checks NOT in the ruleset (post-merge or conditional)

| Check | Trigger | Required? | Note |
|-------|---------|-----------|------|
| `Mirror validated main` | `workflow_run` on CI success | No (post-merge) | Runs after merge to main |
| `gitlab-passive-mirror` | Environment deployment | No (post-merge) | Mirror deployment record |
| `Repository Health Report` | Weekly schedule | No | Informational only |
| `Docker Smoke` | push main + pull_request (path-filtered) | No (not yet stable) | Will become required after stable runs |
| `Package Smoke` | push main + pull_request (path-filtered) | No (not yet stable) | Will become required after stable runs |

## 3. Settings → General → Pull Requests

| Setting | Value | Verification |
|---------|-------|-------------|
| Allow squash merging | ON | VERIFIED BY SCREENSHOT |
| Allow merge commits | OFF | MANUAL VERIFICATION REQUIRED |
| Allow rebase merging | OFF | MANUAL VERIFICATION REQUIRED |
| Allow auto-merge | ON | VERIFIED BY SCREENSHOT |
| Automatically delete head branches | ON | VERIFIED BY SCREENSHOT |
| Always suggest updating pull request branches | ON | VERIFIED BY SCREENSHOT |

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
| Default GITHUB_TOKEN permissions | Read-only | MANUAL VERIFICATION REQUIRED |
| Allow GitHub Actions to create PRs | ON (if GLM opens PRs via workflow) | MANUAL VERIFICATION REQUIRED |
| Fork PR workflows | Approval required | MANUAL VERIFICATION REQUIRED |
| Actions allowed | GitHub-owned + local | MANUAL VERIFICATION REQUIRED |
| Artifact/log retention | 90 days recommended | MANUAL VERIFICATION REQUIRED |

> **Note:** GitHub repository settings are not readable via the unauthenticated
> API. The maintainer must manually verify each setting and update this table.

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
| Dependabot version updates | ACTIVE | PR Dependabot #1 created; `.github/dependabot.yml` committed |

### NOT Verified / Probably OFF

| Setting | Status | Note |
|---------|--------|------|
| Dependency graph | NOT VERIFIED | Capture showed "Enable" button |
| Dependabot alerts | NOT VERIFIED | Capture showed "Enable" button |
| Dependabot security updates | NOT VERIFIED | Capture showed "Enable" button |
| Grouped security updates | NOT VERIFIED | Capture showed "Enable" button |
| Secret scanning | NOT VERIFIED | MANUAL VERIFICATION REQUIRED |
| Push protection | NOT VERIFIED | MANUAL VERIFICATION REQUIRED |
| Private vulnerability reporting | NOT VERIFIED | Capture showed OFF |
| CodeQL | NOT CONFIGURED | Not yet set up |
| Copilot Autofix | NOT VERIFIED | Toggle visible but requires CodeQL for real scanning |

### Recommended (activate progressively after R169 stabilization)

1. Dependency graph → Dependabot alerts → Dependabot security updates
2. Secret scanning → Push protection
3. CodeQL default setup → observe → fix alerts → then consider as required check

### Deferred

| Setting | Status | Note |
|---------|--------|------|
| Require code scanning in ruleset | DEFERRED | Wait for CodeQL stability |
| Actions Policies Preview | DEFERRED | Evaluate mode only if used |
| Self-hosted runners | DEFERRED | Public repo — security risk with fork PRs |
| OIDC | DEFERRED | No cloud credentials needed yet |

## 10. Repository Settings Freeze

After validation of the PR #2 baseline, repository settings are **frozen**.

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
  → GitHub Pull Request
  → Backend (v2) + Frontend (graph-ui) green
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

- Do NOT activate auto-merge until all necessary checks (including
  Package Smoke and Docker Smoke when relevant) have run and are green
- Auto-merge is appropriate when all required checks are in the ruleset
  and stable
- Never use `Merge without waiting for requirements to be met` outside
  a documented break-glass

## 14. Verification Checklist

After any modification to GitHub repository settings:

```
[ ] Ruleset `protect-main` is Active
[ ] Target is `main`
[ ] PR required before merge
[ ] Backend (v2) + Frontend (graph-ui) are required checks
[ ] Squash-only merge
[ ] Force push blocked
[ ] Deletion blocked
[ ] Linear history required
[ ] Conversation resolution required
[ ] Auto-delete head branches ON
[ ] Auto-merge ON (but use carefully)
[ ] Push policy max 5 refs ON
[ ] Environment `gitlab-passive-mirror` restricted to `main`
[ ] Secret `GITLAB_MIRROR_SSH_PRIVATE_KEY` present and non-empty
[ ] Variable `GITLAB_REPOSITORY_SSH_URL` present
[ ] Variable `GITLAB_KNOWN_HOSTS` present
[ ] Variable `GITLAB_MIRROR_KEY_FINGERPRINT` present
[ ] Variable `GITLAB_ED25519_HOST_FINGERPRINT` present
[ ] No self-hosted runners configured
[ ] Dependabot active (github-actions)
[ ] No `pull_request_target` in any workflow without audit
```

## 15. Related Documents

- [GITHUB_GITLAB_BRANCH_BRIDGE.md](GITHUB_GITLAB_BRANCH_BRIDGE.md) — Mirror architecture, postmortem, diagnostic matrix
- [CI_CONTINUITY.md](CI_CONTINUITY.md) — Operational resilience plan
- [RELEASE_POLICY.md](RELEASE_POLICY.md) — Release governance
- [MAINTAINERS_GUIDE.md](../MAINTAINERS_GUIDE.md) — Development workflow and conventions
