# CI Continuity — Operational Resilience Plan

> **R167 introduction.** This document defines the operational response
> when GitHub Actions (the canonical CI) becomes slow, degraded, or
> unavailable. It also documents the quarterly disaster-recovery
> exercise. The GitLab passive mirror is a code-redundancy mechanism,
> **not** an automatic CI failover.

## 1. Architecture recap

```
GitHub  = canonical repository + CI + PRs + reviews + merges
GitLab  = passive mirror of validated GitHub main only (no pipelines)
```

The mirror workflow (`mirror-main-to-gitlab.yml`) only fires after CI on
`main` succeeds. A failed CI never reaches GitLab. The mirror uses
`-o ci.no_pipeline` and the GitLab `.gitlab-ci.yml` declares
`workflow: rules: when never` — no GitLab pipeline is ever created by
the mirror.

This means GitLab is **code redundancy**, not CI redundancy. The shared
runner quota that caused the original R165 incident is never consumed.

## 2. Level 1 — GitHub Actions delayed (slow but available)

Symptoms: CI runs take 2-3x longer than usual, queues form, but runs
eventually complete.

Response:

1. Continue opening PRs and pushing feature branches normally.
2. Do **not** merge PRs while CI is delayed — the merge would carry
   unvalidated code to `main`, and the mirror workflow would propagate
   it to GitLab without CI backing.
3. If you need to validate a branch locally before pushing:
   ```bash
   cd v2 && npm run build && npx vitest run
   cd ../graph-ui && npx tsc --noEmit && npx vitest run
   cd ..
   PACK_DIR="$(mktemp -d)" && INSTALL_DIR="$(mktemp -d)"
   npm pack --prefix v2 --pack-destination "$PACK_DIR"
   npm install --prefix "$INSTALL_DIR" "$PACK_DIR"/*.tgz
   "$INSTALL_DIR/node_modules/.bin/cbm-v2" --version
   docker build --no-cache -t cbm-v2:continuity .
   docker run --rm cbm-v2:continuity --version
   rm -rf "$PACK_DIR" "$INSTALL_DIR"
   ```
4. Wait for the canonical GitHub Actions CI to return to normal before
   resuming merges.
5. If the delay persists > 24 hours, escalate to Level 2.

## 3. Level 2 — GitHub Actions unavailable for an extended period

Symptoms: workflow runs fail to start, runner allocation errors,
GitHub status page reports an active incident lasting hours.

Response:

1. **Freeze all merges** to `main`. Open PRs can still be created and
   reviewed, but do not merge until CI returns.
2. If local validation is required for an urgent fix:
   - Reproduce all five validation jobs locally: backend, Windows smoke,
     frontend, package smoke, and Docker smoke
   - Document the local validation result in the PR description
   - A maintainer may approve an exception merge with explicit
     "merged without CI, locally validated" annotation
3. **Self-hosted runner (CONT-R168-01 security warning)**: for a public
   repository, switching `runs-on: ubuntu-latest` to `self-hosted` in
   workflows that execute on `pull_request` events is **dangerous**. A
   forked PR can run arbitrary code on a persistent runner and
   compromise the machine, credentials, and network. If a self-hosted
   runner is absolutely necessary:
   - Use an **ephemeral JIT runner** (VM destroyed after each job)
   - Restrict to a **single job** with no long-lived secrets
   - Use `workflow_dispatch` or push to a **trusted branch** only
   - **Never** run on `pull_request` from forks
   - Limit the runner group to this repository only
   - The preferred alternative is an **external hosted CI provider** or
     **documented local validation** until a dedicated audit is done.
4. Do **not** reactivate GitLab shared runners as a CI fallback. The
   quota incident that motivated R166 was caused exactly by this
   configuration.
5. Once GitHub Actions returns, re-run any workflows that were queued
   or failed during the outage. Re-merge PRs that were held.
6. Post-incident review: if the outage exceeded 12 hours, document the
   timeline and consider whether a permanent self-hosted runner is
   warranted (with the security constraints above).

## 4. Level 3 — GitHub entirely unavailable

Symptoms: GitHub.com is unreachable, repository cannot be cloned, web
UI returns errors.

Response:

1. **Declare an incident**. This is not a normal operational mode.
2. **Freeze all development** that depends on the canonical repository.
3. **Use GitLab as a read-only recovery source**:
   ```bash
   git clone git@gitlab.com:cheurteen1/codebase-memory-V2.git cbm-recovery
   cd cbm-recovery
   git log --oneline -10  # verify it's at the last mirrored SHA
   git fsck --full        # verify object integrity
   ```
   The GitLab mirror is at most one CI-green SHA behind GitHub `main`.
4. **Do not promote GitLab to canonical**, even temporarily. The
   architecture is unidirectional: GitHub → GitLab. Promoting GitLab
   would require:
   - Re-enabling GitLab CI (which has the quota problem)
   - Re-establishing the bidirectional mirror (which caused the
     original incident)
   - Coordinating a GitHub → GitLab → GitHub resync when GitHub returns
5. If a critical fix is needed during the outage:
   - Develop it on a local branch
   - Validate locally (`npm run build && npx vitest run` in both `v2/`
     and `graph-ui/`)
   - Document the change thoroughly
   - When GitHub returns, push the branch and open a PR with a
     "developed during GitHub outage, locally validated" annotation
6. When GitHub returns:
   - Verify GitHub `main` SHA matches the last known mirror SHA
   - If GitHub lost commits (rare, but possible), reconstruct from
     local clones and the GitLab mirror
   - Resume normal workflow
   - Run a full post-incident review

## 5. What never to do

These shortcuts all reintroduce the failures that R166 was designed to
prevent:

- ❌ Reactivate GitLab shared runners as CI fallback
- ❌ Re-enable `mirror-to-github` (GitLab → GitHub direction)
- ❌ Promote GitLab to canonical, even temporarily
- ❌ Push directly to GitHub `main` to bypass CI (use a PR)
- ❌ Force-push GitLab `main` to "resync" after a divergence
- ❌ Disable branch protection on either side as a workaround
- ❌ Reuse the shared SSH key across GitHub and GitLab

## 6. Quarterly disaster-recovery exercise

Once per quarter, run this exercise to verify the GitLab mirror is a
viable recovery source. Schedule it as a calendar reminder.

### 6.1 Procedure

```bash
# 1. Clone from GitLab (NOT GitHub) into a fresh directory
rm -rf /tmp/cbm-quarterly-exercise
git clone git@gitlab.com:cheurteen1/codebase-memory-V2.git /tmp/cbm-quarterly-exercise
cd /tmp/cbm-quarterly-exercise

# 2. Verify object integrity
git fsck --full --no-reflogs

# 3. Verify the SHA matches GitHub main
GITLAB_MAIN=$(git rev-parse HEAD)
GITHUB_MAIN=$(git ls-remote https://github.com/Cheurteenyt/codebase-mirror.git refs/heads/main | awk '{print $1}')
echo "GitLab main:  $GITLAB_MAIN"
echo "GitHub main:  $GITHUB_MAIN"
test "$GITLAB_MAIN" = "$GITHUB_MAIN" && echo "✓ SHAs match" || echo "✗ DIVERGENCE"

# 4. Verify the passive .gitlab-ci.yml is published
test -f .gitlab-ci.yml && grep -q "when: never" .gitlab-ci.yml && echo "✓ passive CI" || echo "✗ passive CI missing"

# 5. Verify the mirror workflow is published
test -f .github/workflows/mirror-main-to-gitlab.yml && echo "✓ mirror workflow" || echo "✗ mirror workflow missing"

# 6. Build and run smoke tests
cd v2 && npm install --no-audit --no-fund && npm run build && npx vitest run
cd ../graph-ui && npm install --no-audit --no-fund && npx tsc --noEmit && npx vitest run

# 7. Cleanup
cd / && rm -rf /tmp/cbm-quarterly-exercise
```

### 6.2 What to record

After each exercise, append to `worklog.md`:

- Date of exercise
- GitLab main SHA at time of exercise
- GitHub main SHA at time of exercise
- Whether they matched
- Whether build + tests succeeded
- Any anomalies discovered
- Whether any corrective action was needed

### 6.3 Failure handling

If the exercise reveals divergence or broken build:

1. Do **not** force-push GitLab to resync.
2. Open a GitHub PR to fix whatever caused the divergence (e.g. a
   mirror workflow bug, a missing CI step).
3. Once the PR is merged and CI is green, the mirror workflow will
   advance GitLab to the new SHA automatically.
4. Re-run the exercise to confirm.

## 7. Future improvements (out of R167 scope)

- **GitHub self-hosted runner**: a hardened, pre-configured runner that
  activates automatically when GitHub-hosted runners are unavailable.
  Requires separate infrastructure and security review.
- **External CI provider**: a third CI provider (e.g. CircleCI) running
  the same test suite, used only as a redundancy signal (not for
  gating). Requires duplicate workflow definitions.
- **Multi-region Git mirror**: a third mirror (e.g. Codeberg, a
  self-hosted Gitea) for geographic redundancy. Increases operational
  complexity.

These are intentionally deferred. The current single-mirror
architecture is sufficient for the project's risk profile.

## 8. References

- `docs/GITHUB_GITLAB_BRANCH_BRIDGE.md` — full mirror architecture and
  bootstrap postmortem
- `MAINTAINERS_GUIDE.md` — workflow conventions and anti-patterns
- `v2/tests/ci/r166-github-canonical-passive-mirror.test.ts` —
  regression tests for the mirror contract
- `worklog.md` — operational history (R157 → current)

## 6. GitHub signature verification API unavailable

SIG-R169 Phase B is **active**. The signature gate is now enforced
before GitLab mirroring. If the GitHub API is temporarily unavailable,
the mirror will fail closed.

```
TRUSTED_VERIFIER_SHA = 15a732d91984e5b4ffa29b4e129ac0d6316c9fca
```

### Response

- GitLab remains at the last successfully mirrored SHA
- No manual unsigned bypass
- Re-run the mirror workflow after GitHub API recovers
- The signature gate retries with a smart policy:
  - Network errors, HTTP 5xx, gpgverify_error/unavailable: 3 attempts, backoff 1s/2s
  - HTTP 429 or secondary rate limit with `Retry-After` ≤ 10s: honor it
  - HTTP 403 + `x-ratelimit-remaining: 0` (primary exhausted): fail closed immediately
  - HTTP 429 with `Retry-After` > 10s: fail closed (don't waste CI time)

### Acceptable

This is a fail-closed behavior. GitHub remains canonical. GitLab
remains at the last verified SHA. No data is lost.

## 7. SIG-R169 Phase B first production run — wrapper syntax incident

The first production run of the Phase B mirror workflow (commit `aa6486c`)
failed in the `Verify GitHub commit signature` step with:

```text
syntax error near unexpected token `then'
exit code 2
```

**What happened:**
- GitHub API signature verification succeeded (HTTP 200, verified=true)
- The wrapper shell block had an unclosed command substitution `$(`
- Bash could not parse the `if ! STEP_OUTPUTS="$(... )"; then` construct
- The step exited with code 2 before target checkout

**What did NOT happen (fail-closed worked):**
- No GitLab SSH key was materialized
- No GitLab fetch or push was attempted
- GitLab remained at the last valid SHA
- No manual GitLab push was needed

**Recovery procedure:**
- Fix the wrapper through a normal GitHub hotfix PR.
- Do not re-run the defective workflow.
- Do not use a manual GitLab push or bypass.
- After the hotfix is merged and push/main CI succeeds, the corrected
  workflow must fast-forward GitLab to the new main SHA.
- Verify exact GitHub/GitLab SHA parity before closing the incident.
