# GLM 5.2 GitHub Operations

**Status:** Canonical operating contract for reset-prone z.ai sessions.

This profile lets GLM 5.2 checkpoint code with SSH while GitHub opens the PR
and the repository owner remains the only effective code-authorization
authority. No PAT, GitHub App key, merge token, or GitLab credential is stored
in z.ai or in the merge environment.

## 1. Separated capabilities

| Capability | Credential or authority | Available inside z.ai |
|------------|-------------------------|-----------------------|
| Clone and fetch | Public HTTPS | Yes |
| Push checkpoints | Repository-scoped SSH deploy key | Yes |
| Trigger branch workflows and their ephemeral token | Push event plus requested `GITHUB_TOKEN` permissions | Yes, indirectly |
| Open or refresh PR | Short-lived broker `GITHUB_TOKEN` | No |
| Run branch CI | Read-only CI `GITHUB_TOKEN` | No |
| Approve code | `Cheurteenyt` CODEOWNER review on exact SHA | No |
| Approve privileged job | `Cheurteenyt` environment review | No |
| Supported squash and dispatch | Post-approval job `GITHUB_TOKEN` | No |
| Call merge API after exact owner approval | Branch-requested `GITHUB_TOKEN` | Technically possible; unsupported |
| Mirror `main` to GitLab | Separate protected environment | No |

GLM receives no stored GitHub API credential. However, a same-repository write
deploy key is not a contents-only sandbox: it can push a workflow file to its
branch, and that branch workflow can request an ephemeral `GITHUB_TOKEN` with
explicit write permissions. The repository's read-only default is not a
maximum. Therefore the z.ai session and its deploy key are trusted for
repository operations outside protected `main` and must be monitored and
revoked on unexpected activity.

This residual capability does not let GLM review a PR as `Cheurteenyt`, approve
the `glm-merge-gate` environment, bypass an unsatisfied `main` ruleset, or read
the main-only GitLab mirror environment. It does mean that, after the owner has
approved the exact PR head and all native rules are satisfied, a
branch-controlled workflow can request enough ephemeral permission to call the
merge API itself. GitHub rulesets do not make the environment below an
exclusive merge credential.

The hard `main` boundary is therefore the exact `@Cheurteenyt` CODEOWNER review
plus native required checks, resolved conversations, stale-review dismissal,
and squash-only history. The environment is a second operational confirmation
for the supported repository-owned merge-and-dispatch path; it is not a second
independent authorization boundary. A direct branch-controlled merge is
unsupported because its `GITHUB_TOKEN` suppresses the normal post-merge push
workflow chain. Treat one as an incident and run the recovery in section 7.

Making the second confirmation technically exclusive requires a separate
staging repository or a narrowly permissioned GitHub App whose identity is
pinned in the `main` ruleset. A same-repository SSH deploy key cannot provide
that stronger isolation.

## 2. Why the broker remains safe

The canonical `.github/workflows/glm-pr-broker.yml` on `main` runs on pushes to
`v2/glm/**`. It has only `contents: read` and `pull-requests: write`, performs
no checkout, and executes no branch file. It opens one ready same-repository
PR to `main`, or refreshes that PR when another checkpoint arrives.

GitHub exposes PR creation and PR approval by Actions under one repository
setting. Consequently, a branch-controlled workflow could technically submit
a review as `github-actions[bot]` after that setting is enabled. That bot
review is deliberately non-authoritative:

- `main` requires one approving CODEOWNER review;
- `.github/CODEOWNERS` maps every path to `@Cheurteenyt`;
- stale approvals are dismissed on every push;
- the supported merge gate independently requires the latest decisive
  `Cheurteenyt` review to be `APPROVED` on the exact candidate SHA;
- the bot has no ruleset or environment bypass.

The Actions bot cannot impersonate `Cheurteenyt`; its own approval never
satisfies the CODEOWNER rule or the supported merge gate. A compromised GLM
branch workflow still has the residual API/denial-of-service surface described
above. It cannot integrate an unreviewed head into `main` or obtain the GitLab
mirror secret, but it can attempt to merge an exact head already authorized by
the owner.

## 3. Merge gate

`.github/workflows/glm-merge-gate.yml` is loaded from protected `main` through
`workflow_run`. It consumes only successful same-repository `push` runs of the
canonical `CI` workflow for `v2/glm/**`.

### Read-only qualification

The first job verifies:

1. the CI workflow ID and `.github/workflows/ci.yml` path;
2. event `push`, conclusion `success`, same repository, branch prefix, and
   exact 40-character head SHA;
3. exactly one open, ready PR from that branch to `main`;
4. PR author `github-actions[bot]` and exact current head SHA;
5. no difference between base and candidate under the protected control
   plane.

Protected paths are:

- `.github/**`;
- `scripts/ci/**`;
- `.gitmodules`;
- every `AGENTS.md` instruction file.

A legitimate change to one of those paths uses an ordinary maintainer branch
and PR, never the automated GLM gate.

### Supported environment-approved merge

Only after qualification does the second job wait for owner approval of the
`glm-merge-gate` environment. This lets the gate appear immediately after CI:
the owner first submits the PR review, then approves the waiting environment.
After environment approval, the job requires the latest decisive
`Cheurteenyt` review to be `APPROVED` with `commit_id` equal to the candidate,
then revalidates the CI run, PR, exact SHA, and protected trees. No PR checkout,
cache, artifact, module, or script is used by this privileged job.

The merge API receives both `merge_method=squash` and the exact candidate
`sha`. Branch protection remains authoritative, including CODEOWNER review,
required checks, current base, resolved conversations, and linear history.

This is the canonical and audited automation path. The environment protects
this repository-owned privileged job and supplies an explicit operator pause;
it does not prevent another same-repository workflow token from calling the
same merge endpoint after the native owner-review boundary has already been
satisfied.

GitHub suppresses ordinary push workflows caused by `GITHUB_TOKEN`. Therefore
the gate waits until the API reports `refs/heads/main` at the exact squash SHA,
then dispatches, in order:

1. `.github/workflows/ci.yml`;
2. `.github/workflows/codeql.yml`.

Both dispatches use:

```json
{
  "ref": "main",
  "inputs": {
    "expected_sha": "<exact-squash-sha>"
  }
}
```

CI and CodeQL must reject a run if resolved `main` differs from
`expected_sha`. The passive mirror consumes the successful exact-SHA CI
dispatch. A later concurrent `main` update therefore fails closed instead of
silently validating or mirroring the wrong commit.

## 4. Mandatory repository configuration

Do not activate the GLM branch convention until all items below are true.

### 4.1 Deploy key

In **Settings > Deploy keys**:

1. add one key titled `z.ai GLM 5.2 checkpoint writer`;
2. enable write access;
3. record its public fingerprint outside z.ai;
4. store only the private half in the z.ai SSH facility;
5. revoke an old or suspected key immediately;
6. prefer one key per active round and revoke it when the round finishes if
   z.ai cannot guarantee durable key custody.

A deploy key is repository-scoped, not branch-scoped. Protected `main` is the
hard boundary; GLM must push only `v2/glm/**`.

### 4.2 CODEOWNERS and `main` ruleset

The protected base must contain:

```text
* @Cheurteenyt
```

The active `main` ruleset must require:

- a pull request;
- one approving review;
- review from CODEOWNERS;
- dismissal of stale approvals after every new commit;
- the canonical CI checks and current base;
- resolved conversations;
- squash-only linear history;
- no force push, protected-branch deletion, or deploy-key bypass.

Keep automatic deletion of merged head branches enabled so the remote returns
to `main` only after each round.

### 4.3 Actions permissions

In **Settings > Actions > General**:

- keep default workflow permissions read-only;
- enable **Allow GitHub Actions to create and approve pull requests** only
  after the CODEOWNER rules above are active.

The setting permits the broker to create its bot-authored PR. The native
CODEOWNER rule and explicit API review gate ensure that a bot approval cannot
authorize integration.

Read-only default workflow permissions are defense in depth, not a ceiling:
someone who can push a workflow to a same-repository branch can request wider
permissions in that workflow. This is why the deploy-key holder remains a
trusted operational principal even though `main` integration is separately
owner-gated.

### 4.4 Owner-reviewed environment

Environment `glm-merge-gate` must have:

- required reviewer `Cheurteenyt` only;
- deployment branch rule matching `main` exactly;
- administrator bypass disabled;
- no secret and no variable.

If the environment still displays **Allow administrators to bypass configured
protection rules**, disable it in the GitHub UI before enabling the workflow.
Never use **Start all waiting jobs**.

With one maintainer, self-review prevention may need to remain disabled when
GitHub attributes the initiating deploy-key event to the owner. The supported
path still requires a separate explicit environment approval after the exact
PR review. This is an operational release of the canonical job, not an
exclusive ruleset condition. With a second maintainer, enable self-review
prevention.

## 5. GLM procedure

Start a round from current GitHub `main`:

```bash
REPOSITORY=https://github.com/Cheurteenyt/codebase-mirror.git
BRANCH=v2/glm/r<n>-<short-name>

git clone "$REPOSITORY" codebase-mirror
cd codebase-mirror
git switch -c "$BRANCH" origin/main
```

Configure SSH push only after verifying GitHub host trust through a separate
trusted channel. Follow `RESTRICTED_ENVIRONMENT_GIT_TRANSPORT.md`; never trust
blind `ssh-keyscan` output or use `known_hosts=None`.

For each coherent checkpoint:

```bash
git status --short --branch
git add <explicit-paths>
git diff --cached --check
git commit -m "<scoped message>"
git push -u git@github.com:Cheurteenyt/codebase-mirror.git "$BRANCH"
```

Verify the remote checkpoint:

```bash
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git ls-remote --heads \
  git@github.com:Cheurteenyt/codebase-mirror.git \
  "refs/heads/$BRANCH" | awk '{print $1}')"

test -n "$REMOTE_SHA"
test "$LOCAL_SHA" = "$REMOTE_SHA"
```

GLM never runs `gh pr create`, `gh pr merge`, a GitHub review command, or an
API request containing a token. The broker maintains the PR. A reset session
recovers from the remote branch and `docs/ai/CURRENT_HANDOFF.md`.

## 6. Owner procedure

For each broker-authored PR:

1. Confirm author `github-actions[bot]`, head `v2/glm/**`, and base `main`.
2. Inspect the complete diff, audit evidence, and handoff at the exact head.
3. Wait for full branch-push CI on that exact SHA.
4. If GitHub displays **Approve workflows to run**, approve the PR workflow
   only after inspecting the diff, then wait for its duplicate CI run. PRs
   created or updated with `GITHUB_TOKEN` always enter this approval-required
   state.
5. Submit an explicit **Approve** review as `Cheurteenyt` on that head.
6. If another push occurs, inspect again, approve the new PR workflow run when
   prompted, and submit a new review; GitHub
   dismisses the old review and the gate rejects its old `commit_id`.
7. Open the `GLM merge gate` run and compare its PR, CI, exact SHA, and
   protected-control-plane result.
8. Approve the `glm-merge-gate` deployment only if all values match. Never
   bypass the protection rules.
9. After the run resumes, verify the recorded owner review ID and confirm that
   dispatched CI and CodeQL both validate the squash SHA.
10. Verify GitLab `main` equals that SHA and the GLM branch is deleted.

The PR review and environment approval are different decisions. The first
is the native, technically enforced authorization of the code snapshot; the
second releases the supported privileged merge job for that already-approved
snapshot. The second decision cannot be claimed as exclusive while z.ai holds
a same-repository write deploy key.

## 7. Failure and incident handling

- **No PR:** verify `v2/glm/**`, broker run, and the Actions PR setting.
- **No gate:** verify successful push CI, bot-authored ready PR, branch prefix,
  exact head SHA, and unchanged protected paths. The gate should enter its
  environment wait before the owner review is submitted.
- **PR checks awaiting approval:** inspect the exact diff, select **Approve
  workflows to run**, and wait for the PR CI. Never approve an unexpected
  workflow change.
- **Approval rejected as stale:** review and approve the newest head; never
  edit evidence to reuse an old review.
- **Protected-path rejection:** move the change to a maintainer-controlled PR.
- **Merge fails after environment approval:** assume PR, base, review, checks,
  or head changed; obtain fresh CI and both approvals.
- **Dispatch fails after merge:** do not recreate the merge. Manually dispatch
  CI then CodeQL with the already-created exact squash SHA and investigate.
- **Branch-controlled direct merge:** revoke or suspend the deploy key, verify
  that the merged PR head was the exact owner-approved SHA, then manually
  dispatch CI and CodeQL with the live squash SHA. Resume only after CI, CodeQL,
  and the passive mirror all prove that same SHA. If the merged head was not
  exactly owner-approved, treat it as a `main` compromise.
- **Unexpected environment request:** reject it and inspect the originating
  branch/run. Revoke the deploy key if activity is unexplained.
- **Unexpected cache, run, ref, release, or API change:** treat the deploy key
  or z.ai session as compromised, revoke the key, and audit recent branch
  workflow runs before continuing.
- **No exact mirror:** stop the next round until dispatched CI and the passive
  mirror prove the same `main` SHA.

Official GitHub references:

- [GITHUB_TOKEN event behavior](https://docs.github.com/en/actions/concepts/security/github_token)
- [Workflow token security](https://docs.github.com/en/actions/reference/security/secure-use)
- [workflow_run security warning](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [Required reviews and stale approvals](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)
- [Environment reviewers](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers)
- [Exact-SHA pull request merge](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
