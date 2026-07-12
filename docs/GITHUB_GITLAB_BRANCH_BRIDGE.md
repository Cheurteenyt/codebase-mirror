# GitHub Canonical → GitLab Passive Mirror

> **R166 cutover (2026-07-12).** This document replaces the previous
> "GitLab canonical → GitHub mirror" architecture. The migration was
> triggered by the GitLab shared-runner quota exhaustion incident
> during R165. GitLab is no longer a source of truth.

## 1. Architecture

```
   feature branch on GitHub
              │
              ▼
   GitHub Pull Request
              │
              ▼
   GitHub Actions CI (backend + frontend)
              │
              ▼
   review + branch protection rules
              │
              ▼
   merge into GitHub main
              │
              ▼
   CI workflow on push/main
              │
              ▼  (workflow_run, conclusion=success, event=push, head_branch=main)
   mirror-main-to-gitlab workflow
              │
              ▼  (fast-forward only, -o ci.no_pipeline)
   GitLab main
```

## 2. Responsibility of each platform

### GitHub

- **Canonical repository** for source code, branches, tags, issues, PRs.
- **Primary CI** runs on GitHub Actions (`ci.yml`): backend typecheck + build
  + tests + benchmark smoke, frontend typecheck + build + tests.
- **Reviews and merges** happen on GitHub PRs.
- **Mirror trigger** lives on GitHub (`mirror-main-to-gitlab.yml`).

### GitLab

- **Passive mirror** of GitHub `main` only.
- **No pipelines** of any kind (push, MR, schedule, web, API, mirror).
- **No MRs** are opened or merged on GitLab.
- **No schedules**.
- **No runners** are required.
- The `.gitlab-ci.yml` file contains `workflow: rules: when never` plus a
  `passive-mirror-sentinel` job that also has `rules: when never`. This
  provides defense in depth: even if one rule is accidentally removed,
  the other still blocks pipeline creation.

## 3. Secrets and credentials

The GitHub → GitLab mirror uses a **dedicated** SSH key, separate from any
human or bot key. It is stored as a GitHub Actions secret in the
`gitlab-passive-mirror` environment:

| Name | Kind | Purpose |
|------|------|---------|
| `GITLAB_MIRROR_SSH_PRIVATE_KEY` | secret | Ed25519 private key, registered as a project-scoped write-access deploy key on the GitLab repo |
| `GITLAB_REPOSITORY_SSH_URL` | variable | `git@gitlab.com:cheurteen1/codebase-memory-V2.git` |
| `GITLAB_KNOWN_HOSTS` | variable | Pinned GitLab host keys (verified against an official GitLab source) |

The `gitlab-passive-mirror` environment is restricted to the `main` branch.
No manual approval is required (otherwise every mirror would block).

The previous shared SSH key (used during R165 recovery) must be revoked
after the new dedicated key is verified working on a probe branch.

## 4. Mirror workflow state machine

The `mirror-main-to-gitlab` workflow evaluates the following states when
it runs. The state is determined by comparing three SHAs:

- `TARGET_SHA` — the SHA validated by CI on push/main
- `CURRENT_GITHUB_MAIN` — `origin/main` at mirror time
- `REMOTE_SHA` — `gitlab/main` at mirror time

```
                                   ┌────────────────────────────────┐
                                   │  workflow_run received         │
                                   │  TARGET_SHA from CI success    │
                                   └─────────────┬──────────────────┘
                                                 │
                                                 ▼
                          ┌──────────────────────────────────────────┐
                          │  TARGET_SHA still ancestor of            │
                          │  CURRENT_GITHUB_MAIN?                    │
                          └─────────────┬────────────────────────────┘
                                        │ no            │ yes
                                        ▼               ▼
                                  FAIL CLOSED    ┌─────────────────────────┐
                                                 │  fetch gitlab/main      │
                                                 │  REMOTE_SHA = ?         │
                                                 └─────────────┬───────────┘
                                                               │
                                       ┌───────────────────────┼───────────────────────┐
                                       │                       │                       │
                                       ▼                       ▼                       ▼
                              REMOTE_SHA empty       REMOTE_SHA = TARGET_SHA   REMOTE_SHA diverged
                              (initial mirror)       (already mirrored)        (GitLab-only history)
                                       │                       │                       │
                                       ▼                       ▼                       ▼
                                 push TARGET_SHA         no-op                FAIL CLOSED
                                 -o ci.no_pipeline
                                       │
                                       ▼
                            REMOTE_SHA ancestor of TARGET_SHA?
                                       │ yes        │ no
                                       ▼            ▼
                                 push         TARGET_SHA ancestor of REMOTE_SHA?
                                 TARGET_SHA         │ yes        │ no
                                 -o ci.no_pipeline  ▼            ▼
                                       │       no-op        FAIL CLOSED
                                       ▼
                            post-push verify
                                       │
                                       ▼
                                 success / fail
```

## 5. Invariants

1. GitHub `main` is the only source of truth.
2. GitLab `main` only receives commits already present in GitHub `main`.
3. The mirror never pushes feature branches.
4. The mirror never creates GitLab MRs.
5. The mirror never force-pushes (`--force`, `--force-with-lease`, `--mirror`
   are all forbidden).
6. GitLab-only divergence is an incident to investigate, never an
   auto-repair situation. The mirror fails closed.
7. No GitLab runner is required.
8. A failed GitHub CI never reaches GitLab (the `workflow_run` trigger
   requires `conclusion == 'success'`).
9. An older mirror run never rolls back GitLab. If GitLab is already at a
   newer validated SHA, the older run is a no-op.
10. GitHub and GitLab credentials are separated.

## 6. Divergence incident response

If the mirror workflow reports `DIVERGENCE`:

1. **Do not force-push GitLab.** This would destroy history and hide the
   root cause.
2. Inspect the diff between GitLab `main` and GitHub `main`.
3. If GitLab has commits that should be preserved: cherry-pick them onto
   a new GitHub branch, open a GitHub PR, merge normally. The next mirror
   will fast-forward GitLab.
4. If GitLab has garbage commits (leftover from old mirror experiments):
   delete them by advancing GitLab `main` to a known-good GitHub SHA via
   a one-time administrator action. Document the action.
5. If the divergence is unknown or suspicious: freeze both repositories
   and audit.

## 7. Key rotation

1. Generate a new Ed25519 keypair (do not reuse the shared key):
   ```bash
   ssh-keygen -t ed25519 \
     -f ~/.ssh/codebase_gitlab_passive_mirror \
     -C "github-actions-codebase-gitlab-passive-mirror"
   ```
2. Add the **public** key as a project-scoped write-access deploy key on
   the GitLab repository. Limit it to this project only.
3. Store the **private** key as the `GITLAB_MIRROR_SSH_PRIVATE_KEY` secret
   in the `gitlab-passive-mirror` GitHub environment.
4. Verify on a probe branch before relying on it for `main`:
   ```bash
   git push -o ci.no_pipeline \
     gitlab 26f19cd8f07256af517f2018f457145ab1287b5f:refs/heads/automation/github-mirror-auth-probe
   git ls-remote gitlab refs/heads/automation/github-mirror-auth-probe
   git push gitlab --delete automation/github-mirror-auth-probe
   ```
5. Only after a successful probe + first real mirror, revoke the old
   shared deploy key on GitLab and the old deploy key on GitHub, and
   delete the old private key from any filesystem that holds it.

## 8. Recovery

If the mirror workflow is broken or GitLab is severely divergent:

1. Disable the `mirror-main-to-gitlab` workflow on GitHub (Actions tab →
   select workflow → disable).
2. Keep GitHub canonical; do **not** re-enable GitLab → GitHub mirroring.
3. Fix the workflow via a GitHub PR.
4. Manually advance GitLab `main` to the current GitHub `main` SHA via
   an administrator action (one-time fast-forward SSH push).
5. Re-enable the workflow.
6. Trigger a CI run on `main` to fire a new `workflow_run` event.

The rollback must never put GitLab back as source of truth.

## 9. Post-mirror validation

After each mirror run, verify:

- `git ls-remote gitlab refs/heads/main` matches the GitHub `main` SHA.
- No new pipeline appears on GitLab for the mirrored commit.
- No new MR appears on GitLab.
- The mirror workflow's Job Summary reports `result=mirrored` or
  `result=already-mirrored` or `result=newer-valid-mirror-present`.

## 10. Future work (out of R166 scope)

- Tag mirroring (mirror annotated tags + release assets to GitLab).
- Release automation (GitHub Releases as canonical, GitLab as mirror).
- Multi-OS CI matrix (Windows, macOS).
- Lockfile (npm ci instead of npm install).
- DB dialect V1/V2 unification.
- Graph trust protocol.
- Atomic generation publication.
- Project lease/fencing.
- Dry-run parity.

These items remain important but are deferred to keep R166
audit-able and reversible.

## 11. Bootstrap incident record (R165/R166 postmortem)

The current architecture is the result of an incident and a recovery
sequence that must not be forgotten. This section documents what
happened so future maintainers (human or AI) do not reintroduce the
patterns that failed.

### 11.1 Initial incident — GitLab shared runner quota

```
GitLab shared runner quota: 432 / 400 minutes
Consequence: mirror-to-github job could not run
Effect: GitLab main advanced to R165, GitHub main stayed at R164
```

The quota was exhausted by the old bidirectional architecture where
GitLab was canonical and pushed to GitHub via a `mirror-to-github` CI
job. This is what motivated the R166 cutover to GitHub-canonical.

### 11.2 R165 recovery difficulties

1. SSH wrapper (asyncssh/Paramiko) could not perform a duplex Git fetch
   in the recovery environment — only SSH command exec worked.
2. Retrieving files via the GitLab API was insufficient to prove the
   Git commit identity (parents, tree, SHA).
3. No GitHub API credential was available to create a Pull Request from
   the recovery environment.
4. GitHub repository policy blocked `GITHUB_TOKEN` from creating Pull
   Requests (`Allow GitHub Actions to create and approve pull requests`
   checkbox was unchecked).
5. Unauthenticated GitHub REST API rate limit (60/hour, shared per IP)
   was repeatedly exhausted while polling workflow runs.
6. Final recovery: an exact fast-forward SSH push of the R165 commit to
   `main` after a separate `automation/validate-r165` workflow ran the
   full backend + frontend test suite on the exact SHA.

Result:

```
R165 commit preserved exactly (SHA 26f19cd8...)
GitHub main fast-forwarded
GitHub Actions CI green
No force-push used
```

### 11.3 R166 cutover — four mirror runs

The `mirror-main-to-gitlab` workflow required four runs before success:

| Run | Failure mode | Root cause | Fix |
|-----|--------------|------------|-----|
| 1 | `GITLAB_REPOSITORY_SSH_URL is empty` | GitHub environment not configured | Configure environment + secret + 2 variables |
| 2 | `Host key verification failed` | `GITLAB_KNOWN_HOSTS` contained a stale ed25519 host key that did not match what GitLab.com actually presents | Capture live host key via paramiko handshake; compare fingerprint against `SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8` |
| 3 | `GitLab: You are not allowed to push code to protected branches on this project` | Deploy key had write access but was not in the `Allowed to push and merge` list for the protected `main` branch | Add the deploy key to `Allowed to push and merge` for `main` in GitLab Settings → Repository → Protected branches |
| 4 | success | — | — |

### 11.4 Lessons mandatory for future rounds

- A secret/variable being non-empty does not prove it is correct.
- A green SSH configuration step does not prove authentication works.
- `git push --dry-run` does not prove the pre-receive hook will accept
  the real push on a protected branch (the hook does not run on
  dry-run).
- A deploy key with write access must ALSO be authorized by the
  protected-branch rule on `main`.
- A host key captured dynamically from the network must never be
  accepted without comparison to an official pinned fingerprint.
- A monolithic Git step turns multiple causes into an opaque `exit 128`.
- The Job Summary must reflect the exact failing step and the real
  diagnostic, not a generic "Process completed with exit code 128".

## 12. Environment configuration contract

The mirror workflow reads five values from the GitHub environment
named `gitlab-passive-mirror`: 1 secret and 4 variables. All five are
required and the workflow fails closed if any is missing or empty.

| Name | Kind | Purpose |
|------|------|---------|
| `GITLAB_MIRROR_SSH_PRIVATE_KEY` | secret | OpenSSH-format ed25519 private key (387 bytes, no passphrase) |
| `GITLAB_REPOSITORY_SSH_URL` | variable | `git@gitlab.com:cheurteen1/codebase-memory-V2.git` |
| `GITLAB_KNOWN_HOSTS` | variable | Pinned GitLab.com host keys (full file content, not a path) |
| `GITLAB_MIRROR_KEY_FINGERPRINT` | variable | `SHA256:p45GIFj/WYp6QAab9FgwbC0cgGv4EHPj94I8PKQBO5M` — expected client deploy key fingerprint |
| `GITLAB_ED25519_HOST_FINGERPRINT` | variable | `SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8` — expected GitLab.com host key fingerprint |

The environment is restricted to the `main` branch. No required
reviewers and no wait timer — otherwise every mirror would block on a
human.

Common configuration mistakes (each has caused a real failure during
the R166 bootstrap):

- Secret named `GITLAB_MIRROR_PRIVATE_KEY` (wrong name).
- Variable named `GITLAB_REPOSITORY_URL` (wrong name).
- Repository-level secret only (workflow reads environment-level).
- Variable value set to the local filesystem path of `known_hosts`
  instead of the file content.
- Public key pasted into the secret instead of the private key.
- PKCS8 (`*.pem`) format used instead of OpenSSH format.
- Quote marks added around the private key.
- Trailing whitespace or missing newline at end of `END OPENSSH PRIVATE
  KEY` line.

## 13. SSH identities and fingerprints

Three distinct SSH keys are in scope. They must not be confused.

### 13.1 Client deploy key (GitLab, project-scoped)

```
Public key : ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJKTdD3se4yH0BUPpZ1lnIwIpTZzD5UlD8gcjSP6/R9O
Fingerprint: SHA256:p45GIFj/WYp6QAab9FgwbC0cgGv4EHPj94I8PKQBO5M
Registered : GitLab project deploy key (write access + authorized on protected main)
Private key : GitHub Actions secret GITLAB_MIRROR_SSH_PRIVATE_KEY
```

This is the key the mirror workflow uses to authenticate to GitLab as
a client. It is **project-scoped** — never reuse it on another GitLab
project.

### 13.2 Server host key (GitLab.com ed25519)

```
Public key : ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf
Fingerprint: SHA256:eUXGGm1YGsMAS7vkcx6JOJdOGHPem5gQp4taiCfCLB8
Pinned in  : GitHub Actions variable GITLAB_KNOWN_HOSTS
```

This is the key GitLab.com presents as an SSH server. It is **not
secret** — anyone can probe it by connecting to `gitlab.com:22`. Its
role is to let the client verify it is talking to the real GitLab.com
and not a man-in-the-middle. If GitLab rotates this key, the mirror
workflow will fail with `Host key verification failed` — this is the
security working as intended; do not disable `StrictHostKeyChecking`.

### 13.3 Difference between the two

| Aspect | Client deploy key (13.1) | Server host key (13.2) |
|--------|--------------------------|------------------------|
| Belongs to | The client (GitHub Actions) | The server (GitLab.com) |
| Purpose | Authenticate client to server | Authenticate server to client |
| Secret? | Yes — private key never logged | No — public, probed by anyone |
| Stored where | GitHub secret `GITLAB_MIRROR_SSH_PRIVATE_KEY` | GitHub variable `GITLAB_KNOWN_HOSTS` |
| Rotation trigger | Suspected compromise | GitLab announces host key rotation |

A future AI might confuse the two and try to "fix" a host key failure
by rotating the client deploy key, or vice versa. They are independent
and rotate on different schedules.

## 14. Protected branch authorization

GitLab protects `main` against direct pushes by default. A deploy key
with project-level write access is **not** automatically authorized to
push to `main` — it must also be added to the `Allowed to push and
merge` list for `main`.

Configuration path:

```
GitLab → cheurteen1/codebase-memory-V2 → Settings → Repository → Protected branches → main
```

Required state:

```
Branch                       : main
Allowed to merge             : Maintainers
Allowed to push and merge    : Maintainers + github-actions-passive-mirror (deploy key)
Allowed to force push        : NO    (must remain disabled)
```

If the deploy key is removed from `Allowed to push and merge`, the
mirror workflow will fail with:

```
remote: GitLab: You are not allowed to push code to protected branches on this project.
! [remote rejected] <SHA> -> main (pre-receive hook declined)
```

Re-add the deploy key to the list — do **not** disable branch
protection as a workaround.

## 15. Diagnostic matrix

When the mirror workflow fails, classify the error before re-running.
Re-running blindly after a configuration problem is what caused Run 2
and Run 3 during the R166 bootstrap.

| Symptom in logs | Category | Fix |
|-----------------|----------|-----|
| `GITLAB_REPOSITORY_SSH_URL is empty` | ENV_MISSING | Create the `gitlab-passive-mirror` environment + add the variable |
| `GITLAB_MIRROR_SSH_PRIVATE_KEY is empty` or `test -n` failed | SECRET_MISSING | Add the environment secret |
| `Host key verification failed` / `REMOTE HOST IDENTIFICATION HAS CHANGED` | HOST_KEY_MISMATCH | Verify the live GitLab.com host key against an official source; update `GITLAB_KNOWN_HOSTS` |
| `Permission denied (publickey)` | SSH_PUBLICKEY_REJECTED | Verify deploy key fingerprint on GitLab; verify the secret contains the matching private key |
| `GitLab: You are not allowed to push code to protected branches` | PROTECTED_BRANCH_REJECTED | Add deploy key to `Allowed to push and merge` for `main` |
| `! [remote rejected] (non-fast-forward)` | NON_FAST_FORWARD | Investigate divergence; do NOT force-push |
| `DIVERGENCE: GitLab main contains history absent from GitHub main` | DIVERGENCE | Stop. Audit GitLab-only commits. Cherry-pick them to a GitHub PR if they should be preserved. |
| `Could not read from remote repository` | REMOTE_UNREACHABLE | Retry; if persistent, check GitLab status |
| `exit code 128` with no clear cause | UNKNOWN_GIT_ERROR | Re-run the workflow with step-by-step diagnostics (R167 splits the monolithic step) |

## 16. Dry-run limitations

`git push --dry-run` is a useful preflight but does **not** exercise
the server-side `pre-receive` hook. This means:

- A dry-run can succeed even if the real push will be rejected by a
  protected-branch rule.
- A dry-run can succeed even if the real push will be rejected by a
  custom server-side hook.

The mirror workflow uses dry-run only to verify the fast-forward
eligibility and SSH authentication. The real push can still fail on
server-side policies. This is why Run 3 of the R166 bootstrap failed
even though the local dry-run (in the recovery environment) had
succeeded.

When diagnosing a mirror failure, do not assume "the dry-run worked
locally" means "the push should work in CI". The CI runner and the
local environment may have different network paths, different SSH
client versions, and different GitLab server endpoints (load-balanced).

## 17. GitHub Actions / API limitations encountered

These limitations were encountered during R165/R166 and are documented
here so future maintainers do not waste time rediscovering them.

### 17.1 `GITHUB_TOKEN` cannot create Pull Requests by default

Even with `permissions: pull-requests: write` in the workflow YAML,
GitHub blocks `gh pr create` (and the equivalent REST API call) unless
the repository setting **Allow GitHub Actions to create and approve
pull requests** is enabled.

Path: `Settings → Actions → General → Workflow permissions →
Allow GitHub Actions to create and approve pull requests`.

This is a repository-level policy, separate from the workflow YAML
permissions. It cannot be toggled by the workflow itself.

### 17.2 SSH key ≠ GitHub API credential

A deploy key (SSH) authorizes Git transport (`git push`, `git fetch`).
It does **not** authorize REST API calls (`gh pr create`,
`gh api repos/...`). The R165 recovery tried to create a PR via the
SSH-authenticated identity and failed with 403.

To create PRs from GitHub Actions, you need either:

- The repository setting above + the auto-provided `GITHUB_TOKEN`, OR
- A GitHub App installation token with `Pull requests: write`, OR
- A fine-grained PAT stored as a secret.

### 17.3 Unauthenticated API rate limit

The GitHub REST API allows 60 requests/hour per IP when unauthenticated.
This is shared across all users behind the same NAT. The R165 recovery
hit this limit multiple times while polling workflow runs.

For polling Actions runs from outside GitHub Actions, prefer the public
HTML pages (which include status badges) or wait for the rate limit to
reset.

## 18. Break-glass manual mirror runbook

If the `mirror-main-to-gitlab` workflow is broken and you need to
manually advance GitLab `main` to a known-good GitHub SHA, follow this
runbook. This is a one-time administrator action, not a regular
operation.

### 18.1 Prerequisites

- GitHub `main` is at the target SHA and CI is green.
- GitLab `main` is at an ancestor of the target SHA (fast-forward
  eligible).
- You have SSH access to GitLab with a deploy key that is authorized
  on protected `main`.

### 18.2 Steps

```bash
set -euo pipefail

# Use the dedicated mirror key (NOT the shared GLM key)
KEY=/path/to/gitlab_mirror_ed25519
GITLAB_URL=git@gitlab.com:cheurteen1/codebase-memory-V2.git

# Use the current GitHub main SHA — do not hard-code an old SHA
CURRENT_GITHUB_MAIN="$(git ls-remote https://github.com/Cheurteenyt/codebase-mirror.git refs/heads/main | awk '{print $1}')"

# Verify GitLab main is an ancestor (fast-forward eligible)
REMOTE_GITLAB_MAIN="$(git ls-remote "$GITLAB_URL" refs/heads/main | awk '{print $1}')"
git merge-base --is-ancestor "$REMOTE_GITLAB_MAIN" "$CURRENT_GITHUB_MAIN"

# Dry-run first (does NOT exercise pre-receive hook — see section 16)
git push --dry-run -o ci.no_pipeline "$GITLAB_URL" "$CURRENT_GITHUB_MAIN:refs/heads/main"

# Real fast-forward push
git push -o ci.no_pipeline "$GITLAB_URL" "$CURRENT_GITHUB_MAIN:refs/heads/main"

# Verify
git ls-remote "$GITLAB_URL" refs/heads/main
# Must equal $CURRENT_GITHUB_MAIN
```

### 18.3 What never to do

- Do not use `--force`, `--force-with-lease`, or `--mirror`.
- Do not push a SHA that has not passed CI on GitHub `main`.
- Do not push a SHA that is not an ancestor of current GitHub `main`
  (would roll back GitLab).
- Do not disable branch protection as a workaround.
- Do not re-enable GitLab CI pipelines as a workaround.
- Do not promote GitLab to canonical, even temporarily.

If any of these seems necessary, stop and declare an incident.

## 19. GitHub signature verification gate (SIG-R169)

### Current state: Phase B ACTIVATED

The signature gate is now **active** (Phase B merged). The 2-phase
bootstrap is complete:

- **Phase A (completed):** The canonical verifier script, runtime tests,
  and documentation were published and squash-merged as:
  ```
  f5d42688d921f04b4323a017586af4566c17e381
  ```
- **Phase B (active):** The mirror workflow loads the verifier from
  this immutable pinned SHA and executes it before target checkout.

```
TRUSTED_VERIFIER_SHA = f5d42688d921f04b4323a017586af4566c17e381
```

### Rotation procedure

To update the verifier:
1. Publish a new Phase A PR (script + tests + docs only, gate NOT activated)
2. Squash-merge and verify CI green + mirror green
3. Record the new squash SHA
4. Update `TRUSTED_VERIFIER_SHA` in `.github/workflows/mirror-main-to-gitlab.yml`
   in a separate PR

Never use `main`, `HEAD`, `TARGET_SHA`, `github.sha`, or any moving ref as
the verifier source.

Rationale: If the workflow checked out the verifier from the default
branch without a `ref`, `actions/checkout` would use the event SHA
(which for `workflow_run` is the latest commit on the default branch).
This means `TARGET_SHA` could supply its own verifier — a circular
trust root. Pinning to the Phase A SHA breaks the circle.

### Purpose

Once activated, the gate will verify that GitHub has cryptographically
verified the commit at `TARGET_SHA` **before** the mirror workflow
materializes the GitLab SSH key or attempts any push to GitLab.

### Trust boundary (SIG-R169-POLICY-01)

The signature gate is a **provenance check**, not a **safety check**.

It protects against:
- Unsigned direct pushes to `main`
- Commits with invalid or malformed signatures
- Cryptographic identities GitHub does not recognize

It does NOT prove:
- Absence of malicious code in the commit
- Sufficiency of human review
- Immutability of the workflow itself (a future signed+merged PR can
  modify the gate — the pin must be rotated in a separate PR)
- Absence of account compromise

The verifier script is loaded from an immutable pinned SHA (Phase B).
No checked-out repository code is executed before the gate. The
workflow itself remains protected by repository branch protection
rules, not by the signature gate.

### Canonical source (SIG-R169-DIV-01)

The verification logic lives in a **single canonical script**:

```text
scripts/ci/verify-github-commit-signature.sh
```

Phase B will call this script directly from the workflow. There is no
inline duplication. Runtime tests
(`v2/tests/ci/r169-signature-runtime.test.ts`) execute this same script
against a local HTTP fixture server — the tests prove the actual
production code path, not a copy.

### API endpoint

```text
GET /repos/{owner}/{repo}/commits/{TARGET_SHA}
Authorization: Bearer ${{ github.token }}
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
```

### Acceptance criteria

```text
response.sha == TARGET_SHA
commit.verification.verified == true
commit.verification.reason == "valid"
commit.verification.verified_at is a valid ISO-8601 timestamp WITH timezone
```

All four conditions must be met. No partial acceptance.

#### verified_at contract (SIG-R4-VERIFYAT-01)

The `verified_at` field follows the REAL GitHub API contract:

- **On success** (`verified=true`, `reason=valid`): `verified_at` must
  be a non-null ISO-8601 string WITH timezone. Values like `"foo"`,
  `"2026"`, `"2026-07-13T10:00:00"` (no timezone), and `"2026-07-13"`
  (date-only) are all rejected as `SCHEMA_ERROR`.
- **On refusal** (`verified=false`, `reason!=valid`): `verified_at` may
  be `null` (this is the actual GitHub response for unsigned/invalid
  commits). The parser normalizes `null` to `""` in the output JSON.

Incoherent states are rejected as `SCHEMA_ERROR`:
- `verified=true` + `reason!=valid`
- `verified=false` + `reason=valid`

### Reason validation (SIG-R4-PARSER-01)

The `reason` field is validated against the official GitHub enum:
`expired_key`, `not_signing_key`, `gpgverify_error`, `gpgverify_unavailable`,
`unsigned`, `unknown_signature_type`, `no_user`, `unverified_email`,
`bad_email`, `unknown_key`, `malformed_signature`, `invalid`, `valid`.

Any reason not in this enum is rejected as `SCHEMA_ERROR` — this prevents
arbitrary strings from reaching the shell pipe parser and forces a
conscious audit when GitHub introduces new reason values.

### Error categories

| Category | Trigger | Retry? |
|----------|---------|--------|
| `GITHUB_SIGNATURE_CONFIG_ERROR` | Missing/invalid env vars | No |
| `GITHUB_SIGNATURE_API_NETWORK_ERROR` | curl failure | Yes (3×) |
| `GITHUB_SIGNATURE_API_HTTP_ERROR` | 401/404/403(non-rate-limit)/other | No |
| `GITHUB_SIGNATURE_API_RATE_LIMITED` | HTTP 429 or 403+remaining:0 or secondary rate limit | Conditional (see below) |
| `GITHUB_SIGNATURE_API_MALFORMED_JSON` | Invalid JSON | No (SIG-R3-RETRY-01) |
| `GITHUB_SIGNATURE_API_SCHEMA_ERROR` | Missing/malformed verification, bad verified_at, unknown reason | No |
| `GITHUB_SIGNATURE_SHA_MISMATCH` | API SHA != TARGET_SHA | No |
| `GITHUB_SIGNATURE_UNSIGNED` | reason=unsigned | No |
| `GITHUB_SIGNATURE_INVALID` | reason=invalid/malformed_signature | No |
| `GITHUB_SIGNATURE_UNVERIFIED` | reason=unknown_key/expired_key/etc | No |
| `GITHUB_SIGNATURE_TRANSIENT_VERIFIER_ERROR` | reason=gpgverify_error/unavailable | Yes (3×) |

### Retry policy

- Max 3 attempts
- Backoff: 1s, 2s (between attempts 1→2 and 2→3)
- Retries: network errors, HTTP 429 (with Retry-After ≤10s), HTTP 403
  secondary rate limit, HTTP 5xx, gpgverify_error/unavailable
- NO retry for: malformed JSON (SIG-R3-RETRY-01), schema errors,
  unsigned, invalid, SHA mismatch, HTTP 401/404, HTTP 403 non-rate-limit,
  HTTP 403+remaining=0 (primary exhausted)
- `SIGNATURE_RETRY_DELAY_SCALE`: production must be `1`; test mode may
  be `0` or `1` (SIG-R3-RETRY-02). Any other value is rejected.

### Rate limit handling (SIG-R3-RATE-01 + SIG-R4-RATE-01)

GitHub can signal rate limits via:
- HTTP 429 (primary rate limit)
- HTTP 403 + `x-ratelimit-remaining: 0` header (primary rate limit exhausted)
- HTTP 403 + body containing "secondary rate limit"

**Smart retry policy:**

| Condition | Action |
|-----------|--------|
| HTTP 403 + remaining=0 (primary exhausted) | **Fail closed immediately** — retrying with 1s/2s won't succeed before reset |
| HTTP 429 or secondary rate limit + `Retry-After` ≤ 10s | Honor `Retry-After`, retry once |
| HTTP 429 or secondary rate limit + `Retry-After` > 10s | **Fail closed** — don't waste CI time |
| HTTP 429 or secondary rate limit + no `Retry-After` | Use default backoff (1s/2s) |

Response headers are captured via `curl --dump-header` to detect the
403+header case and read `Retry-After`.

### JSON output (SIG-AUD-05, SIG-R169-JSON-01/02)

The script writes JSON to `OUTPUT_FILE` via a trap on EXIT. Values are
passed through environment variables (not string interpolation) to
prevent apostrophe/backslash injection. There is no `key=value` fallback
— if JSON generation fails, the script exits with code 2.

All six fields are always populated after a successful API response,
even on refusal paths (SIG-R169-DIAG-01):

```json
{
  "verified": "true|false|error|not-run",
  "reason": "<GitHub reason>",
  "verified_at": "<ISO timestamp>",
  "api_sha": "<40-char hex>",
  "error_category": "<GITHUB_SIGNATURE_*>",
  "attempts": "<integer>"
}
```

### Phase B: Fail-closed JSON validation (SIG-R3-OUTPUT-01)

When Phase B activates the gate, the workflow wrapper will validate
the JSON output fail-closed:

1. Script exit 0 + JSON absent/empty → step fails
2. Script exit 0 + JSON malformed → step fails
3. Script exit 0 + `verified != true` → step fails
4. Script exit 0 + `api_sha != TARGET_SHA` → step fails
5. Script exit 0 + `error_category != none` → step fails
6. Script exit 1 + valid JSON → diagnostics published, then step fails
7. Any output with multiline values → step fails

This prevents a fail-open scenario where a missing/malformed JSON
allows the push to proceed.

### Phase B: Three verdicts (SIG-R169-Phase-B-CONC, SIG-R169-Phase-B-FINAL)

The workflow has a **final verdict step** that runs LAST (after cleanup)
and **exits 1 on FAILED** — the job goes red if the effective state is
FAILED, not just if an earlier step failed.

**Step ordering (SIG-R169-Phase-B-CLEANUP):**
1. Steps 1-6: validate, checkout verifier, gate, checkout target, SSH, mirror
2. Step 7: **Cleanup** (`id: cleanup`, `if: always()`) — runs before verdict
3. Step 8: **Final verdict + summary** (`if: always()`, LAST step) — exits 1 on FAILED

The verdict requires `steps.cleanup.outcome == success` for SUCCESS/SUPERSEDED.

**Three verdicts:**

```text
Common MIRROR_INVARIANTS_OK (required for SUCCESS and SUPERSEDED):
  - POST_VERIFY_RESULT == success
  - CLIENT_FP_VERIFIED == true
  - HOST_FP_VERIFIED == true
  - ERROR_CATEGORY == none (or empty)
  - ERROR_PHASE == none (or empty)
  - GITHUB_MAIN_SHA non-empty
  - JOB_STATUS == success
  - CLEANUP_OUTCOME == success

SUCCESS mirrored:
  - final_result = mirrored
  - exact parity = true (observed_sha == TARGET_SHA)
  - push_attempted = true
  - push_completed = true
  - MIRROR_INVARIANTS_OK = true
  - signature verified == true + API SHA == TARGET_SHA

SUCCESS already-mirrored:
  - final_result = already-mirrored
  - exact parity = true (observed_sha == TARGET_SHA)
  - push_attempted = false
  - push_completed = false
  - MIRROR_INVARIANTS_OK = true
  - signature verified == true + API SHA == TARGET_SHA

SUPERSEDED:
  - final_result = newer-valid-mirror-present
  - exact parity = false (observed_sha != TARGET_SHA)
  - observed_sha non-empty (GitLab is ahead — a descendant of TARGET_SHA)
  - GITHUB_MAIN_SHA != TARGET_SHA (GitHub main advanced past target)
  - push coherence: EITHER (false/false) OR (true/true) — see below
  - MIRROR_INVARIANTS_OK = true
  - signature verified == true + API SHA == TARGET_SHA

FAILED:
  - everything else → exit 1
```

**SUCCESS and SUPERSEDED leave the job green.** FAILED exits 1.

**Push coherence (SIG-R169-Phase-B-FINAL-INVARIANTS-02, CONC-R3-01):**
- `mirrored` requires `push_attempted=true` AND `push_completed=true`
- `already-mirrored` requires `push_attempted=false` AND `push_completed=false`
- `SUPERSEDED` accepts TWO valid origins (SUPERSEDED_PUSH_COHERENT):
  1. **PREEXISTING**: `push_attempted=false` AND `push_completed=false`
     (GitLab was already ahead before this run)
  2. **AFTER_PUSH_RACE**: `push_attempted=true` AND `push_completed=true`
     (this run pushed TARGET_SHA, then a newer mirror pushed a descendant
     before post-verification)
- Rejected: `push_attempted=true` + `push_completed=false` (push failed)
- Rejected: `push_attempted=false` + `push_completed=true` (impossible)
- Any mismatch → FAILED

**Two origins of SUPERSEDED (SIG-R169-Phase-B-CONC-R3-01):**
1. GitLab was already ahead before this run started — no push needed.
2. A race condition: this run pushed TARGET_SHA successfully, but a newer
   mirror run pushed a descendant before post-verification completed.
   Both runs succeed operationally; no rollback is needed. The last run
   eventually restores convergence.

**Exact target parity vs operational coverage:**
- `Exact target parity: true` means `observed_sha == TARGET_SHA` (GitLab
  is at exactly the commit we wanted to mirror).
- `SUPERSEDED` means GitLab is AHEAD of TARGET_SHA — exact parity is
  `false`, but the mirror is operationally valid because a descendant
  is already present and post-verification succeeded.
- The summary displays these separately:
  - `Exact target parity: true|false`
  - `Operational result: SUCCESS|SUPERSEDED|FAILED`

Never present SUPERSEDED as exact parity.

### Expected GitLab UI badge

GitLab may show "Unverified" for commits signed by GitHub's `web-flow`
identity. This is expected and does not indicate corruption. The
canonical proof is:

```text
GitHub API verified == true
+
GitLab main SHA == GitHub main SHA (exact object parity)
```

### Runtime tests (SIG-R169-RT-01)

The verifier script has both source-inspection tests and runtime tests:

- `v2/tests/ci/r169-signature-gate.test.ts` — source structure,
  token-leak detection with negative fixtures, Phase A bootstrap
  verification, parser contract verification
- `v2/tests/ci/r169-signature-runtime.test.ts` — executes the real
  script against a local HTTP fixture server with 52 test cases:
  - Success: valid, valid+offset, 429-then-valid, 429+Retry-After,
    403-secondary-then-valid, gpgverify-then-valid
  - Refusal (realistic null verified_at): unsigned, invalid,
    malformed_signature, unknown_key, SHA mismatch, gpgverify_error (retry),
    gpgverify_unavailable (retry), verified=true+reason!=valid (SCHEMA_ERROR),
    verified=false+reason=valid (SCHEMA_ERROR), unknown reason (SCHEMA_ERROR)
  - HTTP: 500, 502, 503, 504, 429-permanent, 401, 404, 403-non-rate-limit,
    403+remaining=0 (fail closed), 429+Retry-After=60 (fail closed)
  - JSON/schema: malformed, missing-verification, verified_at absent/foo/2026/no-tz/date-only,
    verified wrong type, reason wrong type
  - Config: missing TARGET_SHA, invalid SHA, missing TOKEN/URL/REPO,
    non-loopback, GITHUB_ACTIONS=true, invalid scale, scale=0 in prod
  - Network: connection refused
  - Fixture verification: method, path, auth, accept, API-version headers,
    request count per scenario

Tests delete `GITHUB_ACTIONS` from the child environment so they can
run in GitHub Actions (SIG-R3-CI-01). A dedicated test verifies that
`GITHUB_ACTIONS=true` + test mode → `CONFIG_ERROR`.

Child process has a 5s watchdog timer (SIG-R3-TESTTIME-01). Server is
closed with a Promise to avoid orphan handles.

Temp file cleanup is verified at runtime with a dedicated TMPDIR
(SIG-R5-TEMP-01): tests confirm no orphaned temp files after 429-then-valid,
500-permanent, 403-primary-exhausted, and 200-success scenarios.

### CI ShellCheck validation (SIG-R4-CI-01, SIG-R5-CI-TEST-01)

The Backend CI job includes a ShellCheck step for security-critical CI
scripts. Configuration:

```yaml
- name: ShellCheck security-critical CI scripts
  uses: ludeeus/action-shellcheck@00cae500b08a931fb5698e11e79bfbd38e612a38 # 2.0.0
  with:
    severity: warning
    scandir: ./scripts/ci
    version: v0.10.0
```

- **Action pinned by SHA** (not tag): `00cae500b08a931fb5698e11e79bfbd38e612a38`
  (verified via GitHub API as the real commit for tag 2.0.0)
- **ShellCheck binary version pinned**: `v0.10.0` (not `stable`) for
  reproducibility (SUPPLY-R5-01)
- **Uses `scandir`** (not the non-existent `additional_paths` input) to
  target `./scripts/ci`
- **Step lives inside the Backend job** — no new required check
- Verified: 2026-07-13

Structural tests in `r169-signature-gate.test.ts` verify the CI YAML:
action ref is a 40-char SHA, `additional_paths` is absent, `scandir`
targets `scripts/ci`, version is explicit, step is in the Backend job.

### Phase B tests (SIG-R169-Phase-B-TEST-01, TEST-FINAL-R169-01)

Phase B adds three test files:

- `v2/tests/ci/r169-phase-b-structural.test.ts` — 50 structural tests
  verifying: verifier pin (exact SHA, ref, path, persist-credentials),
  step ordering (gate before target/SSH, cleanup before verdict, verdict
  is last), fail-closed gate (no continue-on-error, no `|| true`, JSON
  validation, strict attempts regex `^[0-3]$`), three verdicts
  (SUCCESS/SUPERSEDED/FAILED, newer-valid gives SUPERSEDED not SUCCESS),
  MIRROR_INVARIANTS_OK common requirement, push coherence per verdict,
  executable verdict (exit 1 on FAILED, no FAILED path leaves job green),
  cleanup step (id, if:always, outcome referenced), permissions
  (contents:read only, no new secrets).

- `v2/tests/ci/r169-phase-b-wrapper.test.ts` — 29 wrapper validation tests.
  **Extracts the REAL Python wrapper code from the workflow YAML** and
  executes it with fixtures — no duplication. Tests fail if the block
  cannot be extracted, if multiple candidates exist, or if the workflow
  and fixtures are incompatible. Covers: valid JSON, absent/empty/malformed
  JSON, missing/extra keys, multiline values, strict attempts validation
  (string type, regex `^[0-3]$`, success 1-3, diagnostic 0-3, bool/float/
  negative/>3 rejected), exit 0 inconsistency, exit non-zero inconsistency.

- `v2/tests/ci/r169-phase-b-verdict-runtime.test.ts` — 22 verdict runtime
  tests. **Extracts the REAL Bash verdict block from the workflow YAML**
  and executes it with a complete env matrix. Verifies exit code, verdict
  output, and summary content. Matrix: SUCCESS (mirrored, already-mirrored),
  SUPERSEDED (newer-valid, parity false, observed != target), FAILED
  (signature false, API SHA mismatch, cleanup failure, post_verify failure,
  client/host fingerprint false, error_category/phase != none, github_main_sha
  empty, job_status failure, push coherence violations, newer-valid with
  exact parity). Summary content verified for each verdict.

- `v2/tests/ci/r169-phase-b-gate-shell-runtime.test.ts` — 11 gate shell
  runtime tests. **Extracts the COMPLETE `run: |` block** from the
  "Verify GitHub commit signature" step (not just the Python fragment)
  and validates it with `bash -n` + executes it with a fake verifier.
  This prevents shell quoting/command-substitution errors that testing
  only the embedded Python parser cannot detect. Also runs `bash -n` on
  ALL inline Bash blocks in the workflow YAML. Test matrix: success JSON,
  JSON absent/malformed, api_sha mismatch, verified=false, category≠none,
  diagnostic+exit 1, attempts non-canonical.

### Script

`scripts/ci/verify-github-commit-signature.sh` — the canonical verifier.
Phase A: completed (squash-merged as f5d42688d921f04b4323a017586af4566c17e381).
Phase B: active — the mirror workflow calls this script from the pinned SHA.
