# Maintainers Guide — Codebase Memory V2

> Internal conventions, workflow patterns, and "do/don't" rules accumulated
> across multiple audit rounds (see v2/CHANGELOG.md). Public doc (no sensitive info) — for SSH key paths,
> runner IPs, or other operational reminders, see your local
> `MAINTAINERS_NOTES.local.md` (gitignored).

## Workflow: audit → implement → test → docs → commit → push → MR

The canonical workflow for every change (audit fix, new feature, bug fix):

1. **Audit** — read the audit report carefully. Verify each finding against
   the actual codebase before implementing (don't trust the report blindly —
   audit reports have been wrong before, e.g. flagging code that was already
   fixed in a previous round).
2. **Implement** — make the minimal change that fixes the issue. Don't
   refactor unrelated code in the same commit.
3. **Test** — run `npm run build && npx vitest run` in both `v2/` and
   `graph-ui/`. The full suite (see v2/CHANGELOG.md for current test count) must
   pass with 0 regressions before committing.
4. **Docs** — update in parallel: CHANGELOG.md entry, package.json version,
   README/docs references, and any affected operational docs.
5. **Commit** — use atomic checkpoint commits on the work branch so a reset
   cannot erase a round. The PR is squash-merged into one round commit on
   `main`. Message format:
   `infra(v2): R167 Mirror Hardening + Docs Fidelity + Credential Rotation — 0.71.0 → 0.72.0`
6. **Push** — `git push -u origin v2/r<n>-<short-name>` after every coherent
   checkpoint (GitHub is canonical since R166). Each `v2/**` push triggers the
   complete CI before a PR exists; the latest pushed SHA must be green.
7. **PR** — use exactly one Pull Request from `v2/r<n>-<short-name>` to
   `main`. Open it as a draft when durable discussion is useful, or during
   final review to avoid duplicate branch-push and PR runs. After CI is green
   and review is complete, squash-merge into `main`. The
   `mirror-main-to-gitlab` workflow then fast-forwards the validated SHA to
   GitLab `main` with `-o ci.no_pipeline` (passive mirror, no GitLab
   pipelines).

## Naming conventions

- **R<n>** — round number (R44, R45, ..., R77). One per audit/fix cycle.
- **SEC-<n>** — security finding number (SEC-5, SEC-6, ..., SEC-15).
  Numbered sequentially within a security round.
- **D<n>** — design/deployment finding (D1, D2, D3, D4, D5).
- **B<n>** — documentation/build finding (B1, B2, B3).
- **Part <letter>** — section letter in audit reports (Part A, Part B, ...).
- **F<n>** — feature/fix number within a round (F1, F2, ..., F8).
- **H/M/L** — severity prefix in commit messages (HIGH/MEDIUM/LOW).

## Required patterns (do NOT skip these)

### Path safety — use `safe-path.ts`
All filesystem path operations that accept user input (relPath, rootPath,
targetPath) MUST go through `v2/src/utils/safe-path.ts`:
- `safeRealpath(absPath)` — symlink-safe resolution with fallback for
  not-yet-existing paths (routeBrowse, assertPathInsideRoot).
- `safeRealpathStrict(absPath)` — throws on missing path (routeIndex 404).
- `assertPathInsideRoot(rootPath, relPath)` — vault containment check
  (readNote, writeNote, deleteNote).

**CRITICAL**: `assertPathInsideRoot` returns the resolved, symlink-safe real
path. You MUST capture and use this return value for the actual file operation
(readFileSync, writeFileSync, renameSync) — don't just call the check and
discard it. Using the unresolved `join(rootPath, relPath)` would operate on
the symlink, not its target, defeating the containment check. See `routeBrowse`
in `routes/system.ts` for the correct pattern (`targetPath = realTargetPath`).

**Don't** write inline `realpathSync` try/catch blocks. **Don't** use
`resolve()` alone for containment checks — it doesn't follow symlinks.

### Spawn safety — use `--` separator
All `spawn()` calls that pass user-controlled arguments MUST insert `--`
before the user value so the underlying binary treats it as positional:
```ts
spawn('cbm', ['index_repository', '--project', '--', projectName, rootPath], ...)
```
**Don't** rely on regex validation alone — a bare flag like `--force` passes
`/^[a-zA-Z0-9_-]+$/` but `--` makes it safe regardless.

### Process-kill allowlist — use `grep -wE`
The kill endpoint uses `ps aux | grep -wE "cbm|cbm-v2" | grep -v grep` —
whole-word match, not substring. **Don't** broaden to `cbm|node` (would
match every Node.js process on the system).

### YAML parsing — use `maxAliasCount`
All `yaml.parse()` calls MUST pass `{ maxAliasCount: 100 }` to prevent
billion-laughs DoS attacks.

## Anti-patterns (do NOT do these)

### Mirror main — never force, even with lease (R166+)

Since R166 the architecture is GitHub canonical → GitLab passive mirror.
The mirror workflow is **fast-forward only**. A divergence must fail
closed and be audited manually, never auto-repaired.

```bash
# WRONG — destroys GitLab-only history, hides root cause
git push --force             gitlab HEAD:main
git push --mirror            gitlab
# (any other force-push variant, with or without lease, is also forbidden)

# RIGHT — read both SHAs, verify ancestry, fast-forward only
GH_MAIN="$(git rev-parse origin/main)"
GL_MAIN="$(git ls-remote gitlab refs/heads/main | awk '{print $1}')"
git merge-base --is-ancestor "$GL_MAIN" "$GH_MAIN"   # fail-closed if not
git push -o ci.no_pipeline gitlab "$GH_MAIN:refs/heads/main"
```

All force-push variants (bare `--force`, lease-tracked, `--mirror`) are
forbidden since R166. They were legitimate pre-R166 for the old GitLab →
GitHub mirror recovery but are no longer acceptable for the GitLab
passive mirror: any divergence must be audited, not overwritten. The
mirror workflow enforces fast-forward-only semantics via ancestry checks
before any push, and the regression test in
`v2/tests/ci/r166-github-canonical-passive-mirror.test.ts` (extended in
R167) rejects any future reintroduction of force-push flags.

Force-push was sometimes legitimate in the old GitLab → GitHub mirror
(pre-R166) for recovery scenarios. It is no longer legitimate for the
GitLab passive mirror: any divergence is an incident to investigate,
not a situation to overwrite.

### Token in URL — never embed
```bash
# WRONG — token leaks in git error output
git push "https://Cheurteenyt:${TOKEN}@github.com/..." HEAD:main

# RIGHT — token via http.extraHeader, never in URL
AUTH=$(printf '%s' "Cheurteenyt:${TOKEN}" | base64 -w0)
git -c http.extraHeader="Authorization: basic $AUTH" push "$GH_URL" HEAD:main
```

### Frontend loading state — never unconditional setLoading
```ts
// WRONG — unmounts GraphCanvas on every WS refetch, destroys d3 sim
useEffect(() => { setLoading(true); fetch(...) }, [trigger]);

// RIGHT — project-aware stale-while-revalidate
useEffect(() => {
  if (dataProjectRef.current !== project) {
    setLoading(true); setData(null);
  }
  dataProjectRef.current = project;
  fetch(...)
}, [project, trigger]);
```
Plus the GraphTab gate: `if (loading && !data)` (not just `if (loading)`)
— defense-in-depth so the canvas stays mounted even if the hook invariant
is violated.

### GitLab CI — passive mirror since R166
The `.gitlab-ci.yml` file declares `workflow: rules: when never` plus a
`passive-mirror-sentinel` job with `rules: when never`. No pipelines are
created on GitLab for pushes, MRs, schedules, web/API triggers, or the
GitHub → GitLab mirror push (`-o ci.no_pipeline` is also passed by the
`mirror-main-to-gitlab` workflow). If you find yourself adding a real
GitLab job, stop and reconsider: GitHub Actions is the canonical CI.

### YAML script blocks — never use unquoted `: ` in echo
```yaml
# WRONG — YAML parses as a mapping, not a string
script:
  - echo "Source branch: $VAR"

# RIGHT — block scalar
script:
  - |
    echo "Source branch: $VAR"
```

### GitHub Actions permissions — never assume workflow-level is enough
Once any `permissions:` key is set at workflow level, every unlisted scope
becomes `none`. Jobs that need extra scopes (e.g. `actions: read` for the
quota-report API call) must have their own job-level override.

## CI/CD setup (high-level — for secrets/keys, see [REPOSITORY_GOVERNANCE.md](docs/REPOSITORY_GOVERNANCE.md))

- **GitHub Actions** (`.github/workflows/ci.yml`): canonical CI. Jobs:
  backend (typecheck + build + test + benchmark smoke), frontend (same,
  minus benchmark), npm package/install/CLI smoke, and Docker build/CLI/
  non-root smoke. It runs on pushes to `main`, pushes to `v2/**`, and PRs
  targeting `main`. Workflow-level `permissions: contents: read`.
- **GLM checkpoint integration** (`.github/workflows/glm-pr-broker.yml` and
  `.github/workflows/glm-merge-gate.yml`): pushes to `v2/glm/**` use the
  repository-scoped SSH deploy key only. GitHub opens the PR, validates the
  exact successful CI head without executing branch code under a write token,
  requires an exact-head `@Cheurteenyt` CODEOWNER review, then waits for a
  separate owner approval on the `glm-merge-gate` environment before the
  supported exact-SHA squash-and-dispatch job. The CODEOWNER review is the hard
  code-authorization boundary; the environment is an operational confirmation,
  not an exclusive merge credential. See
  [GLM_GITHUB_OPERATIONS.md](docs/GLM_GITHUB_OPERATIONS.md).
  The same-repository write deploy key is not a contents-only sandbox: z.ai is
  a trusted operational principal outside protected `main`, and unexplained
  Actions/API activity requires immediate key revocation.
- **Actions storage** (`.github/workflows/quota-report.yml`): read-only weekly
  quota and stale-reference reporting. Artifact/log retention is seven days;
  cache deletion remains a maintainer-only, exact-ID operation after the ref is
  revalidated as absent. See
  [GITHUB_ACTIONS_STORAGE_POLICY.md](docs/GITHUB_ACTIONS_STORAGE_POLICY.md).
- **GitHub Actions mirror** (`.github/workflows/mirror-main-to-gitlab.yml`):
  triggers on `workflow_run` of `CI` with `conclusion=success`,
  `head_branch=main`, and event `push` or an exact-SHA `workflow_dispatch`.
  Fast-forwards the validated SHA to GitLab `main` with
  `-o ci.no_pipeline`. Uses the `gitlab-passive-mirror` environment with
  `GITLAB_MIRROR_SSH_PRIVATE_KEY` secret and
  `GITLAB_REPOSITORY_SSH_URL`, `GITLAB_KNOWN_HOSTS`,
  `GITLAB_MIRROR_KEY_FINGERPRINT`, and
  `GITLAB_ED25519_HOST_FINGERPRINT` variables.
- **GitLab CI** (`.gitlab-ci.yml`): passive sentinel since R166. No
  pipelines, no MRs, no schedules, no runners. The variable
  `GITHUB_MIRROR_TOKEN` is obsolete and MUST NOT exist — verify its
  absence during the post-mirror operational checklist (the doc cannot
  observe external secrets, so it states the invariant, not the state).
- **Branch protection**: `main` is protected. Push to a `v2/**` feature branch
  → branch CI → GitHub PR → required PR CI → squash merge → mirror auto →
  GitLab `main` (passive).

## Test infrastructure

- **Backend** (`v2/tests/`): see `v2/CHANGELOG.md` for the current test
  count. The number changes every round and is intentionally NOT
  hard-coded here to avoid drift.
- **Frontend** (`graph-ui/src/`): see `v2/CHANGELOG.md` for the current
  test count.

### Test patterns
- Each fix should have a test that would FAIL if the fix were reverted
  (regression test). Don't write tests that pass regardless.
- For path-traversal tests, use real symlinks (not just `..` strings) —
  the symlink escape is the actual attack vector.
- For WebSocket/hook tests, mock at the right level: mock `useGraphData`
  to control loading state, but render the real `GraphTab` so the C1
  chain is exercised end-to-end.

## Audit etiquette

The canonical multi-agent and reset-recovery workflow is
[AI_COLLABORATION_PROTOCOL.md](docs/AI_COLLABORATION_PROTOCOL.md). External
audits use `docs/templates/AI_AUDIT_REPORT_TEMPLATE.md`; implementation state
is tracked separately with `docs/templates/GLM_HANDOFF_TEMPLATE.md`.

When receiving an audit report from another AI (Claude Sonnet 5, etc.):
1. **Verify each finding** against the actual codebase before implementing.
   Audit reports have been wrong before — e.g. flagging code that was
   already fixed, or claiming a utility was wired up when it wasn't (R55
   Part A found exactly this: safe-path.ts existed but was dead code).
2. **Don't blindly trust "FIXED" claims** in the previous round's summary.
   Re-verify directly.
3. **Document what you DIDN'T fix** — if a finding is acknowledged but
   not fixed (e.g. D2 residual in R55), say so explicitly in the CHANGELOG.
4. **Update docs in parallel** — CHANGELOG, package.json version, README
   test/bug counts, CHANGELOG.md entry + version bump in package.json. A fix without docs
   is incomplete.
5. **Conservative scope** — only flag real issues in your own audits, not
   stylistic preferences. If something looks fine, don't flag it.

## Versioning

- **Package version** (`v2/package.json`): semver, bumped per round.
  - 0.x.y for pre-1.0. Each round = one minor or patch bump.
  - See `v2/package.json` for the current version. Do NOT hardcode version numbers in docs.
- **Extractor semantics version** (`v2/src/indexer/schema.ts` `CURRENT_EXTRACTOR_SEMANTICS_VERSION`):
  bumped whenever the extractor's semantic output changes in a way that invalidates existing
  `file_hashes`. Incremental mode compares the stored version to this constant; a mismatch
  forces a full reindex before any cross-file resolution is published. Currently 8.
- **Discovery policy version** (`v2/src/indexer/schema.ts` `CURRENT_DISCOVERY_POLICY_VERSION`):
  R154+. Tracks changes to the broken-symlink / alias-history / contribution / visibility
  policy. When the stored version is less than current, the cold-start lock applies.
  Currently 2 (R155: fingerprint v2 + atomic commit + special file safety).
  Separate from extractor semantics (which tracks AST output).
- **Backup format version** (`backup.ts`): independent schema version,
  bumped only when the JSON shape changes.
- **DB migration version**: 4 migrations (initial_schema, optimize_indexes,
  cbm_links_junction_table, human_nodes_fts).

## Invariants (R143+, R153 additions)

These invariants MUST hold for every round. Violations are P1 bugs.

1. **Persisted output change → semantics version bump.** If the extractor's
   output changes in a way that invalidates existing `file_hashes` (new rows,
   changed rows, removed rows), `CURRENT_EXTRACTOR_SEMANTICS_VERSION` MUST be
   bumped. Incremental mode relies on this to force a full reindex.
   R152/R153 NOTE: policy changes (broken symlink handling, alias history)
   that don't change the AST output do NOT require a bump.

2. **Partial discovery → no publish, no delete.** If `discovery.complete=false`,
   the indexer MUST NOT `clearProjectData` (full mode) or compute
   `deletedRelPaths` (incremental mode). The existing graph is preserved.

3. **Stale returned → stale persisted and read by UI/MCP.** If the indexer
   returns `crossFileCallsStale=true`, it MUST also persist
   `cross_file_calls_stale=1` in the `projects` table. Graph Status MUST read
   this field and report STALE regardless of DB age or git changes.

4. **Canonical root propagated.** `assertDiscoveryRoot` returns the canonical
   realpath. This value MUST be used for ALL downstream operations (discovery,
   extraction, `nodeRelative`, `updateProjectStats`). `file_path` must NEVER
   contain `..`.

5. **Tests filesystem: Linux non-root + cross-platform.** Permission tests
   (chmod 000) must run as a non-root user. Cross-platform tests (Windows
   junction, macOS) are a known gap (PKG-CARRY-01).

6. **Declared results ≠ CI-certified results.** "All tests pass" in a commit
   message is a declared result. GitHub Actions CI is the certified result.
   Do not claim CI-green without a workflow run on the SHA.

7. **Workflow Git (GitHub canonical since R166).** GitHub HTTPS for
   clone/history/PR/merge (canonical). GitLab SSH deploy key for mirror
   push only (`-o ci.no_pipeline`, fast-forward only, no force-push).
   Use `git -C <abs>` (bash loses CWD). Verify `local SHA = remote SHA`
   after push.

8. **R153 — Alias history protection.** A broken alias (ENOENT or ELOOP on
   realpath) that was previously valid (has an entry in `alias_history`)
   MUST protect its old canonical target from deletion:
   - file target → excluded from `deletedRelPaths` (incremental)
   - directory target → subtree-prefix excluded from `deletedRelPaths` (incremental)
   - any protected path → `hasUncertainty=true` (full mode aborts to preserve graph)
   The `alias_history` table MUST survive `clearProjectData` (full reindex).
   Entries for aliases no longer on disk MUST be garbage-collected on the
   next successful run.

9. **R153 — Warning propagation.** `IndexResult.warnings` MUST be present in
   ALL return paths that have a discovery result (dry-run, partial discovery,
   full uncertainty, no-op, deletion-only, main). `discoveryWarnings` MUST be
   built IMMEDIATELY after discovery succeeds, BEFORE any early return.

10. **R153 — Typed outcome.** `IndexResult.outcome` MUST be set in all return
    paths. The CLI MUST print warnings BEFORE the outcome banner. The outcome
    values are: `SUCCESS`, `SUCCESS_WITH_WARNINGS`, `STALE`, `PARTIAL`, `FAILED`.

11. **R154 — Bootstrap state.** `alias_history_initialized` and
    `discovery_policy_version` MUST be set on successful index. The cold-start
    lock fires when `alias_history_initialized=0` OR
    `discovery_policy_version < CURRENT_DISCOVERY_POLICY_VERSION` AND there
    are broken aliases AND existing nodes > 0. The lock blocks all deletions
    (incremental) and forces hasUncertainty (full).

12. **R154 — Root fingerprint.** `alias_history` is scoped by
    `(project, root_fingerprint, alias_path)`. Reusing the same project name
    with a different root MUST NOT inherit stale history. The fingerprint is
    `canonicalRoot:st_dev`.

13. **R154 — Contribution filter.** Only contributive aliases are historized:
    file aliases require `detectLanguage !== null`; directory aliases require
    at least one discovered file under the prefix. Non-contributive aliases
    are tracked as warnings but NOT persisted.

14. **R154 — Target visibility.** Broken aliases with a still-visible target
    (directly or via another alias) do NOT force stale. Only genuinely absent
    targets are protected.

15. **R154 — Atomicity + GC.** `persistAliasHistory` MUST be wrapped in
    `try { } finally { db.close() }`. The GC uses `last_observed_run_id`
    stamping (O(1) SQL), NOT dynamic `NOT IN` params.

16. **R155 — Atomic alias state commit.** On successful index, alias_history
    persist + project stats (fresh + initialized + policy + root_fingerprint)
    MUST be committed in a SINGLE transaction via `commitAliasStateAtomically()`.
    If persist fails, the ENTIRE transaction rolls back — the graph stays
    stale, `alias_history_initialized` stays 0, `last_successful_index_at`
    is NOT advanced. The R154 non-atomic pattern (updateProjectStats THEN
    persistAliasHistory in separate transactions) is FORBIDDEN.

17. **R155 — Root fingerprint v2.** The fingerprint is
    `canonicalRoot:st_dev:st_ino` (NOT just `canonicalRoot:st_dev`). On
    untrustworthy filesystems (dev=0, ino=0), falls back to
    `canonicalRoot:untrusted`. A directory deleted and recreated at the
    same path gets a NEW fingerprint (st_ino changes).

18. **R155 — Special file type safety.** `resolvedAliases.push` MUST be
    inside the `isFile()` or `isDirectory()` branch — NEVER before the type
    check. Special files (FIFO, socket, device) MUST NOT be historized.

19. **R155 — STALE outcome contract.** `outcome='STALE'` MUST have
    `errors: []`. The contract is `errors>0 → FAILED`. STALE carries the
    reason in `crossFileCallsStale=true` + DB `last_index_error`, NOT in
    the `errors` array.

20. **R155 — UUID runId.** `runId` MUST be `randomUUID()`, NOT `Date.now()`.
    The `last_observed_run_id` column is TEXT (not INTEGER).

## Round history (last 10 rounds)

| Round | Version | Theme |
|---|---|---|
| R46 | 0.11.0 | transaction atomicity + component test coverage |
| R47 | 0.11.1 | performance + invisible bugs |
| R48 | 0.11.2 | CI fix + invisible bugs |
| R49 | 0.11.3 | deep audit + perf |
| R50 | 0.11.4 | cache invalidation + perf revert |
| R51 | 0.12.0 | security audit (1 CRITICAL + 7 fixes) |
| R52 | 0.12.1 | CI quality + security hardening |
| R53 | 0.12.1 | Claude Sonnet R8 audit (D1/D2/B1-B3/Part C/Part E) |
| R54 | 0.12.1 | CI pipeline fix (workflow:rules + block scalars + lease SHA) |
| R55 | (see CHANGELOG) | Claude Sonnet R9 audit (Part A + D3 + D4 + D5) |
| R56 | 0.12.3 | self-audit + MAINTAINERS_GUIDE (symlink escape test, backup version clarify) |
| R57 | 0.12.4 | doc cleanup + private maintainers notes (12 stale refs, pitfalls/checklist/lessons) |
| R58 | 0.12.5 | code quality + type safety + perf (18 as any→row types, 3 hot-path prepared statements) |
| R59 | 0.12.6 | code quality in sqlite-ro.ts (30 as any→row types, 2 hot-path prepared statements) |
| R60 | 0.12.7 | code quality in swr-cache.ts (dead ternary, evictOne extracted, defensive iteration, typed events) |
| R61 | 0.12.8 | code quality in server.ts (7 catch(any)→catch(unknown), 2 ws as any→WeakMap, errorMessage helper) |
| R62 | 0.12.9 | code quality in importer.ts + generator.ts (importAllFiles dedup, 4 catch(any)→catch(unknown), existingBySlug typed) |
| R63 | 0.13.0 | **architecture refactor** — server.ts 1212→290 lines, split into 7 files (types, helpers, routes/{graph,project,human,index,system}), RouteContext abstraction |
| R64 | 0.13.1 | deep audit — 1 bug fixed (routeIndex 202→500 on spawn ENOENT), 36 catch(any)→catch(unknown) across MCP+CLI+graph-ui, schema r:any typed |
| R65 | 0.13.2 | V1 C engine audit (65K LOC, reference read-only) — 1 HIGH strcat overflow, 2 MEDIUM unchecked malloc + slab_owns O(n), docs/V1_AUDIT_R65.md |
| R66 | 0.13.3 | performance benchmark suite — 19 benchmarks, all excellent. SWR 0.0003ms, prepared 0.006ms, bulk 88x speedup. docs/PERFORMANCE_BENCHMARK_R66.md |
| R67 | 0.13.4 | V1+V2 combined benchmark — V1 index 305ms (460 nodes), V2 query 0.006ms. Key gap: V2 depends entirely on V1 for code analysis. docs/V1_V2_BENCHMARK_R67.md |
| R68 | 0.14.0 | **native TS/JS indexer** — V2 can index without V1 `cbm` binary. ts-morph, 48 files→352 nodes→1070 edges, 1833ms. New `cbm-v2 index` CLI. Schema-compatible with V1. |
| R69 | 0.15.0 | **WASM tree-sitter** — 112 languages, 5.4x faster than R68 (340ms vs 1833ms). Within 12% of V1 C speed. No binary dependency. New deps: web-tree-sitter + tree-sitter-wasm. |
| R69b | 0.15.1 | Fix: package.json deps lost during npm install. Restored all original + new deps. |
| R70 | 0.15.2 | Claude Sonnet R10 audit — vault.ts path safety, WASM anonymous@line, benchmark caveat. |
| R71 | 0.15.3 | **worker_threads parallel indexing** — worker.ts, 2+ workers, 100+ file threshold, two-pass edge resolution. |
| R72 | 0.15.4 | **fast-walker** — descendantsOfType() WASM traversal, 1.3x speedup. New fast-walker.ts. Dead code removed. |
| R73 | 0.15.5 | micro-optimizations — no descendantCount/text.length, pre-built JSON, Map O(1) parent. V2 9% faster than V1 C (277ms vs 305ms). |
| R74 | 0.15.6 | two-phase extraction — Phase 1 extract all (no SQLite), Phase 2 write all (1 transaction). Skip tree.delete (WASM GC). Architectural consistency. |
| R75 | 0.15.7 | pre-read files, skip setLanguage, multi-row batch INSERT. V2 **10% faster than V1 C** (273ms vs 305ms). |
| R76 | 0.15.8 | single-pass complexity + skip anonymous. V2 **12% faster than V1 C** (267ms vs 305ms). |
| R77 | 0.15.9 | **honest benchmark** — V2 is 11% SLOWER in wall time (401ms vs 361ms) but 20% faster in extraction only (267ms vs 335ms). V1 extracts 2.2x more edges (LSP). Previous "V2 faster" claims corrected. |

See `v2/CHANGELOG.md` for the full history (R1 → current). `docs/V2_ROADMAP.md` is archived at 0.15.9.

---

## Common pitfalls (things that have caused bugs before)

These are the recurring mistakes that audit rounds keep catching. Read this
before every change to avoid re-introducing them.

### 1. "FIXED" claims in previous rounds that weren't actually fixed
**Pattern**: A previous round's summary says something is fixed, but the fix
was never wired up. R55 Part A found exactly this: `safe-path.ts` existed
with a docstring claiming "Used by both vault.ts and server.ts" — but neither
file imported it. The duplication risk R8 warned about was still fully present.

**Prevention**: Before claiming "fixed", grep for actual usage. Don't trust
the previous round's summary — re-verify directly against the code.

### 2. Stale version/test/bug counts in docs
**Pattern**: After a round, `package.json` version is bumped but docs still
reference the old version. Test counts in README/CHANGELOG drift (V2_ROADMAP is archived).
R56 caught 12 stale refs across v2/README.md, CONTRIBUTING.md, and
MAINTAINERS_GUIDE.md.

**Prevention**: After every version bump, grep for the old version across all
`.md` files: `grep -rn "0\.<old-version>" *.md docs/*.md v2/*.md`. Same for
test counts: `grep -rn "<old-count> tests" *.md docs/*.md`.

### 3. YAML `: ` in script blocks parsed as mapping
**Pattern**: `echo "Source branch: $VAR"` in a YAML `script:` list is parsed
as a mapping `{'echo "Source branch': '$VAR"'}`, not a string. GitLab CI
rejects it with "script config should be a string or a nested array of strings".
R54b fixed this.

**Prevention**: Always use block scalars (`|`) for multi-line scripts in YAML.
Never put unquoted `: ` in a `- echo "..."` line.

### 4. Force-push is no longer legitimate for the GitLab passive mirror (R166+)
**Historical pattern (pre-R166)**: the old GitLab → GitHub mirror
recovery sometimes used force-push with lease SHA tracking. R54c
documented the workaround for stale-info errors on URL push.

**R166 change**: the GitLab passive mirror is **fast-forward only**.
`--force`, all force-push-with-lease variants, and `--mirror` are
forbidden. A divergence between GitHub `main` and GitLab `main` must
fail closed and be audited manually — never auto-repaired by a
force-push. The mirror workflow enforces this via
`git merge-base --is-ancestor` checks before any push.

**Prevention**: do not reintroduce force-push for the mirror. If the
mirror workflow reports `DIVERGENCE`, investigate the GitLab-only
commits before doing anything else.

### 5. Workflow-level `permissions:` silently breaks job-specific API calls
**Pattern**: Setting `permissions: contents: read` at workflow level makes
every unlisted scope `none`. A job that calls `/repos/.../actions/runs` needs
`actions: read` — without a job-level override, it 403s silently and the
`.get('total_count', 0)` fallback masks the error. R55 D3 fixed this.

**Prevention**: Any job that makes GitHub API calls must have its own
job-level `permissions:` override listing ALL scopes it needs.

### 6. MR pipelines with zero jobs = "Pipelines must succeed" blocked
**Historical pattern (R54, pre-R166)**: GitLab MR pipelines with no jobs
blocked "Pipelines must succeed". R54 fixed this with a `mr-preflight`
job. R166 made this entirely moot by making GitLab a passive mirror with
no pipelines at all.

**Prevention (R166+)**: Do not re-enable GitLab pipelines. If you find
yourself adding a real GitLab job, stop: GitHub Actions is the canonical
CI. The `.gitlab-ci.yml` file must keep `workflow: rules: when never`.

### 6b. Passive mirror invariants (R166+)

The `mirror-main-to-gitlab` workflow enforces the following invariants.
Violating any of them is a regression:

1. **validated SHA only** — the workflow checks out
   `github.event.workflow_run.head_sha`, not `main` implicitly.
2. **fast-forward only** — the workflow verifies ancestry with
   `git merge-base --is-ancestor` before pushing.
3. **main only** — the workflow triggers only when `head_branch == 'main'`
   and the canonical CI event is `push` or an exact-SHA
   `workflow_dispatch`. Dispatched runs must pass the canonical preflight and
   still equal the live `main` ref before mirror credentials are materialized.
4. **no GitLab pipelines** — the push uses `-o ci.no_pipeline`, and
   `.gitlab-ci.yml` enforces `workflow: rules: when never`.
5. **no rollback** — if GitLab is already at a newer validated SHA, the
   older run is a no-op.
6. **divergence fail-closed** — if GitLab has commits not in GitHub
   `main`, the workflow fails and never force-pushes.
7. **credentials separated** — the GitLab deploy key is dedicated
   (`GITLAB_MIRROR_SSH_PRIVATE_KEY`), not the shared key used during
   R165 recovery.
8. **strict host checking** — the workflow pins GitLab host keys via
   `GITLAB_KNOWN_HOSTS` and uses `StrictHostKeyChecking yes`.
9. **cleanup** — the workflow always removes SSH material at the end
   (`if: always`).

### 7. Unconditional `setLoading(true)` unmounts components on refetch
**Pattern**: `useEffect(() => { setLoading(true); fetch(...) }, [trigger])`
sets loading=true on every WebSocket-triggered refetch, which unmounts
`<GraphCanvas>` and destroys the d3-force simulation. This was the C1
regression that lasted 3 rounds (R43-R45).

**Prevention**: Use project-aware stale-while-revalidate: only set
`setLoading(true); setData(null)` on project SWITCH, not on same-project
refetch. Plus the `if (loading && !data)` gate (not just `if (loading)`)
as defense-in-depth.

### 8. `npm ci` requires synchronized committed lockfiles
**Pattern**: A manifest changes without its lockfile, so reproducible setup
fails on a fresh clone or resolves a different dependency graph locally.

**Prevention**: Keep `v2/package-lock.json` and `graph-ui/package-lock.json`
committed and synchronized with their manifests. Use `npm ci` for CI and
reset recovery. Do not hide a mismatch by falling back to `npm install`.

### 9. Committing in the wrong repo
**Pattern**: The shell doesn't persist `cd`, so `git add -A` runs in the
wrong directory. R51 had a commit land in `/home/z/my-project` instead of
`/home/z/my-project/work/cbm-r18`, losing all the fixes.

**Prevention**: Always use `git -C /path/to/repo` for git commands, or
verify `pwd` before any git operation. Never rely on `cd` persisting across
bash invocations.

---

## Pre-commit checklist

Before committing any change, verify:

- [ ] `cd v2 && npm run build` succeeds (0 TypeScript errors)
- [ ] `cd v2 && npx vitest run` passes (0 failures — see CHANGELOG for count)
- [ ] `cd graph-ui && npx tsc --noEmit` succeeds (0 TypeScript errors)
   - [ ] `cd v2 && npm run bench:incremental:smoke` passes (incremental invariants)
- [ ] `cd graph-ui && npx vitest run` passes (0 failures; derive the count from the run)
- [ ] Total: 0 regressions (see CHANGELOG for test count)
- [ ] `v2/package.json` version bumped
- [ ] `v2/CHANGELOG.md` has a new entry for the round
- [ ] All `.md` files have consistent version refs (`grep -rn "<old-version>" *.md docs/*.md v2/*.md` returns nothing)
- [ ] Test/bug/round counts in CHANGELOG.md are up to date (V2_ROADMAP.md is archived)
- [ ] If touching CI: YAML validated (`python3 -c "import yaml; yaml.safe_load(open('<file>'))"`)
- [ ] If touching security: regression test added that would FAIL if the fix were reverted
- [ ] Commit message follows the format: `<type>(v2): <version> R<n> <short-description> (<n> fixes, <details>)`
- [ ] Push the single GitHub work branch and verify its remote SHA

---

## Lessons learned (things that have broken before)

A running list of "gotchas" that caused real incidents. Add to this list
when you discover a new one.

### Environment resets
The implementation environment may lose SSH keys, dependencies, cloned
repositories, and terminal context. Follow
[AI_COLLABORATION_PROTOCOL.md](docs/AI_COLLABORATION_PROTOCOL.md):

1. Re-clone the single active `v2/**` branch from GitHub over HTTPS.
2. Verify local `HEAD` equals the remote branch head and the worktree is clean.
3. Read `docs/ai/CURRENT_HANDOFF.md` and its pinned audit before editing.
4. Restore dependencies with `npm ci` and run the recorded smoke command.
5. Restore push-only SSH transport using
   [RESTRICTED_ENVIRONMENT_GIT_TRANSPORT.md](docs/RESTRICTED_ENVIRONMENT_GIT_TRANSPORT.md).
6. Continue only the handoff's single `next_action`, then commit and push a
   new checkpoint.

The implementation key is GitHub-scoped only. It is never registered on
GitLab and never receives the passive-mirror credential. Replaced ephemeral
GitHub public keys must be revoked by the maintainer.

### GitLab API 403 from this environment
The GitLab API returns 403 from this IP (Cloudflare blocks HK region, private
project). Use `ls-remote` for sync verification, not the API. GitHub API
works but rate-limits to 60 req/hr unauthenticated.

### Paramiko SSH wrapper is slow for deep fetches
`git fetch` via the paramiko wrapper times out for deep history (50+ commits).
Workarounds:
- Use `git ls-remote` for quick sync checks (just compares SHAs)
- Clone from GitHub (HTTPS, no paramiko) instead of GitLab (SSH, paramiko)
- Use `--depth=N` for shallow fetches when possible

### `sed -i` over-replaces version strings
Using `sed` to bump a version across all docs also changes the
historical round entries in CHANGELOG.md. Always verify after sed:
`grep -rn "<new-version>" v2/CHANGELOG.md` and fix historical entries
that shouldn't have been changed.

### Branch protection blocks remote branch deletion
`git push origin --delete v2/round50` fails silently if branch protection
is enabled on GitLab. Delete via GitLab UI instead.
