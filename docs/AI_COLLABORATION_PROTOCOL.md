# AI Collaboration and Reset-Recovery Protocol

**Status:** Canonical maintainer workflow for external AI audits and
reset-prone implementation environments.

## 1. Purpose

This protocol keeps a development round recoverable when:

- an external web auditor can inspect and write a Markdown report but cannot
  edit the repository;
- the implementation agent can edit, test, commit, and push, but its local
  environment, SSH key, dependencies, and recent terminal state may be reset;
- a human maintainer transfers reports and manages repository credentials;
- GitHub is the canonical repository and GitLab is a passive `main` mirror.

Conversation memory is useful context, but it is never the source of truth.
Every claim must be tied to a Git object, a report pinned to a commit, or a
GitHub Actions run.

## 2. Authority order

When two sources disagree, use this order:

1. GitHub Git object at an exact 40-character commit SHA.
2. GitHub Actions result attached to that exact SHA.
3. Current implementation handoff committed on the work branch.
4. Immutable external audit report pinned to `audited_sha`.
5. Chat or model memory.

A branch name alone is not evidence because it moves. A report without an
`audited_sha` is advisory only. A local test result is `DECLARED_LOCAL` until
GitHub Actions validates the pushed SHA.

## 3. Roles

| Role | Responsibilities | Must not do |
|------|------------------|-------------|
| External web auditor | Inspect an exact SHA, identify evidence-backed findings, produce a new Markdown report | Claim to have edited files, silently rewrite an imported report, or declare CI green |
| Implementation agent | Verify findings, implement minimal fixes, run local tests, maintain the handoff, commit and push checkpoints | Trust findings blindly, leave important work only local, expose credentials, or keep a GitHub API token in a reset-prone environment |
| Human maintainer | Transfer reports, register or revoke scoped SSH keys, review gated integrations, and make product decisions | Put a private key in chat, a report, a commit, or a PR |
| Integration reviewer | Compare the pushed diff, audit report, handoff, and CI; accept, reject, or defer findings | Mark a finding closed without a pushed commit and behavioral evidence |
| GitHub Actions | Provide the authoritative validation result for pushed SHAs | Mirror feature branches to GitLab |

The integration reviewer may be the maintainer, Codex, or another independent
reviewer. No particular AI product is required by the protocol.

### 3.1 Automated GLM GitHub profile

GLM 5.2 sessions running in z.ai use the dedicated profile documented in
`GLM_GITHUB_OPERATIONS.md`. GLM receives only a repository-scoped SSH deploy
key and pushes `v2/glm/**` checkpoints. GitHub Actions opens the PR with a
short-lived `GITHUB_TOKEN`; after exact-SHA branch-push CI succeeds, a separate
`workflow_run` job provides the supported squash path after `Cheurteenyt`
submits an `APPROVED` CODEOWNER review on that exact SHA and separately
approves the protected `glm-merge-gate` environment.

No PAT, GitHub App private key, merge credential, environment secret, or
GitLab mirror credential is stored in z.ai or in the merge environment. The
broker's Actions identity may open the PR but cannot satisfy the required
`@Cheurteenyt` CODEOWNER review. Every new push dismisses the native approval,
and the gate independently compares the owner review's `commit_id` with the
candidate SHA. The privileged merge job never checks out or executes
branch-controlled code, and the gate refuses to integrate any GLM change to
the automated control-plane paths.

This is a code-authorization boundary, not a full GitHub API sandbox. A write deploy
key can push a branch workflow that requests wider ephemeral `GITHUB_TOKEN`
permissions. The z.ai session and deploy key are therefore trusted for
repository operations outside `main`; unexpected cache, run, ref, release, or
API activity requires immediate key revocation. Isolating those side effects
requires a separate staging repository or a contents-only GitHub App.

The exact owner CODEOWNER review, stale-review dismissal, required checks,
resolved conversations, and squash-only rule are the enforceable `main`
boundary. After that exact head is approved, a branch workflow can technically
request enough permission to call the merge API. Direct GLM merge remains
unsupported and incident-worthy because it bypasses the repository-owned
post-merge dispatch path. The environment is an operational confirmation for
that supported path, not an exclusive merge authorization.

Because a `GITHUB_TOKEN` merge suppresses the ordinary `push` workflow chain,
the gate first proves that `main` equals the exact squash SHA, then dispatches
CI and CodeQL with that SHA as mandatory input. The passive mirror consumes
the successful exact-SHA CI dispatch.

## 4. One-round lifecycle

At rest, the remote contains only `main`. During a round, use exactly one work
branch and one Pull Request. The standard branch form is
`v2/r<n>-<short-name>`; the automated GLM profile must instead use
`v2/glm/r<n>-<short-name>` so its broker and gated merge policy apply.

1. Resolve the current baseline from `origin/main`; do not reuse a baseline
   copied from an older report.
2. Create the work branch from that baseline.
3. Copy `docs/templates/GLM_HANDOFF_TEMPLATE.md` to
   `docs/ai/CURRENT_HANDOFF.md`, set `last_completed_code_sha` equal to the
   resolved `base_sha`, and fill the round contracts and non-goals.
4. Push the first checkpoint. Pushes to `v2/**` trigger the complete CI even
   when no PR exists. The latest pushed SHA must be green; older pending runs
   may be replaced by a newer checkpoint.
5. Under the automated GLM profile, the PR broker opens or refreshes the
   single ready PR without a token in z.ai. Its merge gate consumes the
   successful branch-push CI run and does not depend on the PR-opening event
   starting another workflow. The owner reviews and approves the exact head,
   then separately releases the supported merge job through its environment.
   Under the standard profile,
   optionally open the single PR as a draft early. Keeping it until the end
   provides a durable discussion and review location. If it is opened late,
   branch-push CI still protects the earlier checkpoints.
6. Preflight each external report for repository identity, required metadata,
   private paths, and secret material. If unsafe, refuse it and request a
   redacted replacement. Import an accepted report as a new immutable file
   under `docs/ai/audits/<round>/`; never edit findings to appear resolved.
7. Track decisions and resolutions in `CURRENT_HANDOFF.md`, with one stable
   finding ID such as `R169C-A01-F001` mapped to its audit source, a commit,
   and a regression test.
8. Run the final audit against the last code SHA. Import that report only in a
   trailing documentation commit, then archive the completed handoff under
   `docs/history/round-reports/` and remove `CURRENT_HANDOFF.md`.
9. Squash-merge the PR, verify dispatched CI and CodeQL on the exact `main`
   squash SHA, verify the GitLab mirror at that SHA, and delete the work branch.

An open PR causes both branch-push and PR validation runs. For PRs created or
updated by the GLM broker's `GITHUB_TOKEN`, GitHub creates the PR workflow runs
in an approval-required state. After reviewing the exact diff, the owner must
select **Approve workflows to run** and wait for those duplicate checks before
merge. The push CI remains the merge gate's qualification source. Under the
standard human-created PR profile, the duplicate PR checks normally start
without this extra approval. Do not add path filters or duplicate workflows
with the same job names.

## 5. External audit contract

ChatGPT Web or another read-only auditor produces a new report from
`docs/templates/AI_AUDIT_REPORT_TEMPLATE.md`. The report is transferred by
the maintainer. Before commit, the implementation agent checks that it names
the correct repository and SHA and contains no credential, private key,
environment-specific private path, or unredacted secret. An unsafe report is
never committed or edited in place: request a redacted replacement. An
accepted report is committed without changing the auditor's findings.

Import each report in its own commit. Resolve its stable Git blob OID with:

```bash
git rev-parse "HEAD:docs/ai/audits/<round>/<report>.md"
```

Record that blob OID in the next handoff commit. Do not hash working-tree
bytes: CRLF/LF conversion can make such a digest environment-dependent.

Before acting on a report:

```bash
AUDITED_SHA=<40-character-sha-from-report>

git cat-file -e "${AUDITED_SHA}^{commit}"
git merge-base --is-ancestor "$AUDITED_SHA" HEAD
git show --stat --oneline "$AUDITED_SHA"
```

If the SHA does not exist, is not an ancestor of the current work, or the
report names a different repository, stop. Ask for a new audit or record an
explicit `REJECTED` decision in the handoff.

Allowed implementation decisions are:

- `ACCEPTED` — reproduced and scheduled for correction;
- `REJECTED` — not reproduced, with direct evidence;
- `DEFERRED` — valid but outside the round, with a named owner or future round;
- `IMPLEMENTED` — correction committed and pushed;
- `CI_VERIFIED` — GitHub Actions succeeded on a recorded exact head SHA that
  contains the resolution commit; changes between them are handoff/audit
  documentation only.

Only the handoff changes state. The original audit remains an immutable
snapshot. A later auditor writes a differential report for `old_sha..new_sha`.
Finding IDs use `<round>-<audit-sequence>-F<number>`; severity is never encoded
in the ID.

## 6. Checkpoint contract for reset-prone environments

Complete a checkpoint after each coherent finding or small group of tightly
related findings. A checkpoint is a code commit followed by a handoff commit;
this avoids asking a file to predict the SHA of its own containing commit:

1. Run the narrow regression test.
2. Run the widest affordable local validation.
3. Commit the code and tests, then record that commit as `CODE_SHA`.
4. Update `docs/ai/CURRENT_HANDOFF.md` with `CODE_SHA` and the evidence.
5. Commit the handoff update as a separate documentation checkpoint.
6. Push both commits to GitHub in one ref update. If reset risk is immediate,
   push `CODE_SHA` before preparing the handoff commit.
7. Verify that the remote branch points to the local handoff commit. Record
   that exact head as `ci_verified_head_sha` when its CI succeeds.

```bash
BRANCH="$(git branch --show-current)"
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git ls-remote --heads origin "refs/heads/$BRANCH" | awk '{print $1}')"

test -n "$REMOTE_SHA"
test "$LOCAL_SHA" = "$REMOTE_SHA"
git status --short --branch
```

Do not write the handoff file's containing commit SHA into the handoff itself;
that is self-referential. `last_completed_code_sha` names the preceding code
commit. Derive the current branch head from GitHub during recovery.

If push is unavailable and a reset may occur, create a bundle and a binary
patch outside the repository as described in
`RESTRICTED_ENVIRONMENT_GIT_TRANSPORT.md`. Never commit those recovery files.

## 7. Recovery after a reset

The first objective is recovery, not new implementation:

```bash
REPOSITORY=https://github.com/Cheurteenyt/codebase-mirror.git
WORK_BRANCH=v2/r<n>-<short-name>

git clone --single-branch --branch "$WORK_BRANCH" "$REPOSITORY" codebase-mirror
cd codebase-mirror
git fetch origin main "$WORK_BRANCH"

test "$(git branch --show-current)" = "$WORK_BRANCH"
test "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$WORK_BRANCH")"
test -f docs/ai/CURRENT_HANDOFF.md
git status --short --branch
```

Then:

1. Read `docs/ai/CURRENT_HANDOFF.md` completely.
2. Verify that `last_completed_code_sha` is an ancestor of `HEAD`.
3. If `active_audit` is not `NONE`, verify its Git blob OID and read it
   completely.
4. Restore dependencies with `npm ci`, not `npm install`.
5. Run the narrow smoke command recorded in the handoff.
6. Resume only the single `next_action` item.

SSH is needed only for push. Restore it using
`RESTRICTED_ENVIRONMENT_GIT_TRANSPORT.md`; clone and fetch may remain HTTPS.
After a key is replaced, the maintainer revokes the obsolete public key on
GitHub.

## 8. Secret and host-trust rules

- Never commit or paste a private key, token, key path, runner address, or
  environment-specific secret.
- Never store a GitHub PAT or API-capable credential in a reset-prone
  implementation environment. The GLM profile uses SSH only for push and keeps
  the supported PR/merge orchestration in owner-controlled GitHub Actions.
  This does not make a same-repository write deploy key contents-only: a pushed
  branch workflow can request an ephemeral GitHub token, so the deploy-key
  holder remains a trusted operational principal.
- The implementation agent never receives the GitLab mirror private key.
- A newly observed SSH host key is not trustworthy merely because a connection
  returned it. Verify the GitHub host fingerprint through a separate trusted
  channel before writing `known_hosts`.
- Do not use `known_hosts=None` as a bootstrap trust mechanism.
- Use a project-scoped write key with the minimum required access, and revoke
  replaced ephemeral keys.

## 9. Final acceptance gate

The final external audit targets `FINAL_CODE_SHA`. Importing the report and
archiving the handoff necessarily creates later documentation commits. Those
commits are allowed only when this command shows no product, workflow, or test
change after the audited code:

```bash
UNEXPECTED_PATHS="$(
  git diff --name-only "$FINAL_CODE_SHA"..HEAD \
    | grep -Ev '^(docs/ai/|docs/history/round-reports/)' \
    || true
)"

test -z "$UNEXPECTED_PATHS" || {
  printf '%s\n' "$UNEXPECTED_PATHS" >&2
  echo "non-documentation change after final audit" >&2
  exit 1
}
```

If any other file changes, obtain a differential audit for the new code SHA.

The round is complete only when:

- every finding is `REJECTED`, `DEFERRED`, or `CI_VERIFIED` with evidence;
- no important work is local-only;
- the candidate branch SHA has the four required GitHub checks green;
- the PR is squash-merged into protected `main`;
- the `main` merge commit is verified and its CI is green;
- GitLab `main` exactly matches GitHub `main`;
- the work branch is deleted and no active handoff remains on `main`.

Do not copy permanent test counts, dependency versions, or environment
capabilities into this protocol. Derive them from manifests and workflows;
historical reports may record them only when tied to an exact SHA.
