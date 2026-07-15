# GitHub Actions storage policy

This policy keeps GitHub Actions dependency-cache storage observable and
predictable without allowing an automation or an AI agent to delete shared
cache state on its own.

## Repository settings

- Artifact and workflow-log retention must remain **7 days** in
  **Settings > Actions > General > Artifact and log retention**.
- Dependency-cache retention must remain **7 days since last access** in
  **Settings > Actions > General > Cache settings**.
- The cache storage limit is currently **10 GB**. The repository variable
  `ACTIONS_CACHE_LIMIT_GB` must contain the same value (`10`).
- GitHub may evict least-recently-accessed entries when the configured limit is
  exceeded. The repository does not add a second scheduled deletion mechanism.

These are independent retention controls. Artifact/log retention governs run
logs and uploaded artifacts. Cache retention governs reusable dependency-cache
entries according to their last access time; it does not use artifact age. The
Quota Report's `CACHE_RETENTION_DAYS` value models only the cache review window
and never claims to measure artifact or log retention.

Both retention values are GitHub repository settings, not workflow inputs. The
reporting token intentionally has no repository-administration permission, so a
maintainer must verify both settings after any GitHub settings change. The
artifact/log value can be read with
`GET /repos/{owner}/{repo}/actions/permissions/artifact-and-log-retention`;
changing it remains a separate, explicit maintainer operation.

The cache-limit endpoint also requires repository-administration access and is
therefore deliberately unavailable to the read-only automatic `GITHUB_TOKEN`.
After changing the effective limit, a maintainer must verify
`GET /repos/{owner}/{repo}/actions/cache/storage-limit` with an owner token and
update `ACTIONS_CACHE_LIMIT_GB` to the same positive integer. A missing or
invalid variable makes the report fail closed instead of estimating capacity.

## Read-only observability

`.github/workflows/quota-report.yml` runs every Monday at 00:00 UTC and can also
be launched with `workflow_dispatch`. It uses only the automatic
`GITHUB_TOKEN`, with these permissions:

```yaml
permissions:
  contents: read
  actions: read
```

No deploy key, personal access token, GitLab credential, or repository secret
is required. The workflow performs only authenticated `GET` requests. It never
calls a cache deletion endpoint.

The step summary reports:

- active cache count and bytes from the cache-usage endpoint;
- count and bytes recomputed from a complete, validated, paginated cache list;
- the owner-verified configured storage limit, conservative usage percentage,
  and remaining capacity;
- distinct refs, refs that no longer exist, and the size attached to them;
- dependency-cache entries not accessed during the seven-day cache window;
- workflow-run count and remaining API rate limits.

A cache ref is classified as obsolete only when GitHub returns `404` for the
corresponding full Git ref. The report first resolves the repository's default
branch exactly, so a missing permission cannot silently make every ref appear
obsolete. Any other unexpected response fails the report. Pagination is
retried when the cache set changes mid-read, then fails closed if a stable
complete snapshot cannot be obtained.

GitHub documents that the usage endpoint can lag by several minutes. If its
snapshot differs from the complete list, the report raises a warning and uses
the larger byte value for quota evaluation. It never chooses the smaller,
more optimistic value.

## Alert thresholds

| Condition | Result | Required response |
|---|---|---|
| Usage below 70% | Healthy unless another warning applies | No action |
| Usage at or above 70% | Warning annotation | Review cache growth and obsolete refs |
| Usage at or above 85% | Error annotation and failed job | Maintainer review before more cache-producing changes |
| Obsolete refs use at least 10% of listed bytes | Warning annotation | Consider targeted manual cleanup |
| Entry not accessed for more than 7 days | Warning annotation | Verify GitHub eviction and settings |
| API, JSON, pagination, schema, or ref-classification error | Failed job | Fix observability; do not infer a healthy state |

The thresholds are declared in the workflow's job environment. Changes to them
must be reviewed like a security-policy change. Do not raise a threshold merely
to make a warning disappear.

## Storage-efficient cache design

When changing CI, maintainers and GLM 5.2 must follow these rules:

1. Cache dependencies and expensive reproducible tool outputs only. Never cache
   build artifacts, logs, credentials, or the whole worktree.
2. Base cache identity on the operating system, toolchain version, and relevant
   lockfile hash. Avoid a unique key per commit when the dependencies did not
   change.
3. Keep cached paths narrow and documented. A new cache must have a measurable
   time benefit that justifies its stored size.
4. Do not add a second cache for data already handled by `setup-*` actions.
5. Review the next Quota Report after modifying cache keys or paths.

## Safe manual cleanup

Cleanup is exceptional and maintainer-controlled. A warning alone does not
authorize an agent to delete anything.

1. Manually run **Actions > Quota Report > Run workflow** on `main`.
2. Read the obsolete-ref table and confirm that the candidate is not
   `refs/heads/main` and is not an open pull-request ref.
3. Recheck the ref immediately before deletion. Replace `REF_SUFFIX` with the
   part after `refs/` (for example `heads/old-branch`):

   ```powershell
   gh api "repos/Cheurteenyt/codebase-mirror/git/ref/REF_SUFFIX"
   ```

   Continue only when GitHub returns `404`. Any `200`, `403`, timeout, or other
   result means **stop**.
4. List the exact cache IDs attached to that full ref:

   ```powershell
   gh api --paginate `
     "repos/Cheurteenyt/codebase-mirror/actions/caches?ref=refs/heads/old-branch&per_page=100" `
     --jq '.actions_caches[] | [.id, .ref, .key, .size_in_bytes, .last_accessed_at] | @tsv'
   ```

5. Review each ID and delete only the selected entry, one ID at a time:

   ```powershell
   gh api --method DELETE `
     "repos/Cheurteenyt/codebase-mirror/actions/caches/CACHE_ID"
   ```

6. Run Quota Report again and retain the successful run as evidence.

Never use bulk deletion by key, an unbounded loop, or automatic deletion on a
schedule. Never delete a cache for `main`, an existing branch, or an open pull
request merely to reduce the displayed usage.

## GLM 5.2 boundary

GLM 5.2 may inspect the report, improve cache-key design in a reviewed branch,
and propose exact cache IDs for cleanup. It must not delete caches, change the
repository retention or storage limit, or reinterpret a failed report as
healthy. Deletion and GitHub settings changes require an explicit maintainer
decision outside the reset-prone agent environment. This is an operating
policy, not a capability boundary: a same-repository write deploy key can push
a branch workflow that requests Actions API permissions. Unexpected deletion
is therefore a credential incident and requires immediate key revocation.

Official references:

- [GitHub Actions cache REST API](https://docs.github.com/en/rest/actions/cache)
- [Dependency caching reference and eviction policy](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
- [Managing GitHub Actions settings for a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
