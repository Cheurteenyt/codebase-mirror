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
