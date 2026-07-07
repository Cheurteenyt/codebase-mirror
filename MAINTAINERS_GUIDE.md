# Maintainers Guide — Codebase Memory V2

> Internal conventions, workflow patterns, and "do/don't" rules accumulated
> across 59 audit rounds. Public doc (no sensitive info) — for SSH key paths,
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
   `graph-ui/`. The full suite (378 tests: 355 backend + 23 frontend) must
   pass with 0 regressions before committing.
4. **Docs** — update in parallel: CHANGELOG.md entry, version bump in
   package.json, README/docs version refs, V2_ROADMAP round entry + metrics.
5. **Commit** — one commit per round (e.g. R56). Message format:
   `docs(v2): 0.12.3 R56 self-audit + MAINTAINERS_GUIDE (3 improvements)`
6. **Push** — `git push origin v2/r<n>-<short-name> -o merge_request.create
   -o merge_request.target=main -o merge_request.title="..."` (single line,
   no newlines in push options).
7. **MR** — GitLab MR with `mr-preflight` job (R54) passes in ~2s. Merge
   → mirror auto → GitHub Actions CI (3 jobs: backend, frontend, quota-report).

## Naming conventions

- **R<n>** — round number (R44, R45, ..., R59). One per audit/fix cycle.
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

### Mirror job — never `--force` without lease
```bash
# WRONG — silently overwrites GitHub-only commits (e.g. merged PRs)
git push "$GH_URL" HEAD:main --force

# RIGHT — fails loudly if GitHub main diverged
GH_MAIN=$(git ls-remote "$GH_URL" refs/heads/main | awk '{print $1}')
git push "$GH_URL" HEAD:main --force-with-lease=main:"$GH_MAIN"
```

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

### GitLab CI — never `if: $CI_COMMIT_BRANCH == "main"` only
For MR pipelines, `$CI_COMMIT_BRANCH` is undefined. Use `workflow:rules` +
a `mr-preflight` job so MR pipelines have at least one passing job (R54).
Without this, "Pipelines must succeed" blocks MRs.

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

## CI/CD setup (high-level — for secrets/keys, see local notes)

- **GitLab CI** (`.gitlab-ci.yml`): lightweight mirror to GitHub + weekly
  quota-check. Uses `GITHUB_MIRROR_TOKEN` CI variable (masked). Deploy key
  (project-scoped, write access) on both GitLab and GitHub.
- **GitHub Actions** (`.github/workflows/ci.yml`): primary CI. 3 jobs:
  backend (typecheck + build + test), frontend (same), quota-report
  (schedule-only, R55 D5). Workflow-level `permissions: contents: read`;
  quota-report has job-level `actions: read` override (R55 D3).
- **Branch protection**: `main` is protected. Push to feature branches →
  MR → merge → mirror auto → GitHub Actions.

## Test infrastructure

- **Backend** (`v2/tests/`): 32 test files, 353 tests, vitest.
- **Frontend** (`graph-ui/src/`): 11 test files, 23 tests, vitest +
  @testing-library/react + jsdom.
- **Total**: 376 tests, all passing at time of writing (0.12.2).

### Test patterns
- Each fix should have a test that would FAIL if the fix were reverted
  (regression test). Don't write tests that pass regardless.
- For path-traversal tests, use real symlinks (not just `..` strings) —
  the symlink escape is the actual attack vector.
- For WebSocket/hook tests, mock at the right level: mock `useGraphData`
  to control loading state, but render the real `GraphTab` so the C1
  chain is exercised end-to-end.

## Audit etiquette

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
   test/bug counts, V2_ROADMAP round entry + metrics. A fix without docs
   is incomplete.
5. **Conservative scope** — only flag real issues in your own audits, not
   stylistic preferences. If something looks fine, don't flag it.

## Versioning

- **Package version** (`v2/package.json`): semver, bumped per round.
  - 0.x.y for pre-1.0. Each round = one minor or patch bump.
  - Currently 0.12.6 (R59).
- **Backup format version** (`backup.ts`): independent schema version,
  bumped only when the JSON shape changes. Currently `0.10.3` (frozen
  since R36 — the schema hasn't changed).
- **DB migration version**: 4 migrations (initial_schema, optimize_indexes,
  cbm_links_junction_table, human_nodes_fts).

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
| R55 | 0.12.2 | Claude Sonnet R9 audit (Part A + D3 + D4 + D5) |
| R56 | 0.12.3 | self-audit + MAINTAINERS_GUIDE (symlink escape test, backup version clarify) |
| R57 | 0.12.4 | doc cleanup + private maintainers notes (12 stale refs, pitfalls/checklist/lessons) |
| R58 | 0.12.5 | code quality + type safety + perf (18 as any→row types, 3 hot-path prepared statements) |
| R59 | 0.12.6 | code quality in sqlite-ro.ts (30 as any→row types, 2 hot-path prepared statements) |

See `docs/V2_ROADMAP.md` for the full history (R1 → R59).

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
reference the old version. Test counts in README/CONTRIBUTING/V2_ROADMAP drift.
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

### 4. `--force-with-lease` fails on URL push without explicit SHA
**Pattern**: `git push --force-with-lease "$URL" HEAD:main` fails with "stale
info" on the 2nd+ run because git has no remote-tracking ref for a bare URL.
R54c fixed this.

**Prevention**: Always `ls-remote` first to get the expected SHA, then
`--force-with-lease=main:<sha>`. For first-time mirror (empty ls-remote),
fall back to `--force`.

### 5. Workflow-level `permissions:` silently breaks job-specific API calls
**Pattern**: Setting `permissions: contents: read` at workflow level makes
every unlisted scope `none`. A job that calls `/repos/.../actions/runs` needs
`actions: read` — without a job-level override, it 403s silently and the
`.get('total_count', 0)` fallback masks the error. R55 D3 fixed this.

**Prevention**: Any job that makes GitHub API calls must have its own
job-level `permissions:` override listing ALL scopes it needs.

### 6. MR pipelines with zero jobs = "Pipelines must succeed" blocked
**Pattern**: If all jobs have `if: $CI_COMMIT_BRANCH == "main"` and the
pipeline is a `merge_request_event`, `$CI_COMMIT_BRANCH` is undefined → all
jobs filtered out → empty pipeline → "Pipelines must succeed" blocks the MR.
R54 fixed this.

**Prevention**: Always have `workflow:rules` + at least one job that runs on
`merge_request_event` (the `mr-preflight` job).

### 7. Unconditional `setLoading(true)` unmounts components on refetch
**Pattern**: `useEffect(() => { setLoading(true); fetch(...) }, [trigger])`
sets loading=true on every WebSocket-triggered refetch, which unmounts
`<GraphCanvas>` and destroys the d3-force simulation. This was the C1
regression that lasted 3 rounds (R43-R45).

**Prevention**: Use project-aware stale-while-revalidate: only set
`setLoading(true); setData(null)` on project SWITCH, not on same-project
refetch. Plus the `if (loading && !data)` gate (not just `if (loading)`)
as defense-in-depth.

### 8. `npm ci` fails because `package-lock.json` is gitignored
**Pattern**: Dockerfile or CI uses `npm ci` but `.gitignore` excludes
`package-lock.json` (platform-specific lockfiles). The build fails on fresh
clone.

**Prevention**: Always use `npm install --no-audit --no-fund`. Never `npm ci`
unless you commit the lockfile.

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
- [ ] `cd v2 && npx vitest run` passes (355 backend tests, 0 failures)
- [ ] `cd graph-ui && npx tsc --noEmit` succeeds (0 TypeScript errors)
- [ ] `cd graph-ui && npx vitest run` passes (23 frontend tests, 0 failures)
- [ ] Total: 378 tests, 0 regressions
- [ ] `v2/package.json` version bumped
- [ ] `v2/CHANGELOG.md` has a new entry for the round
- [ ] All `.md` files have consistent version refs (`grep -rn "<old-version>" *.md docs/*.md v2/*.md` returns nothing)
- [ ] Test/bug/round counts in README.md, CONTRIBUTING.md, V2_ROADMAP.md, MAINTAINERS_GUIDE.md are up to date
- [ ] If touching CI: YAML validated (`python3 -c "import yaml; yaml.safe_load(open('<file>'))"`)
- [ ] If touching security: regression test added that would FAIL if the fix were reverted
- [ ] Commit message follows the format: `<type>(v2): <version> R<n> <short-description> (<n> fixes, <details>)`
- [ ] Push with MR options on a SINGLE LINE (no newlines in push options)

---

## Lessons learned (things that have broken before)

A running list of "gotchas" that caused real incidents. Add to this list
when you discover a new one.

### Environment resets
The development environment has been reset multiple times (lost SSH keys,
paramiko, cloned repos). Recovery steps:
1. Reinstall paramiko: `/home/z/.venv/bin/python3 -m pip install paramiko cryptography`
2. Regenerate SSH key: use Python `cryptography` library (Ed25519)
3. Recreate `/home/z/.config/cbm/ssh-wrapper.py` (paramiko-based, shebang `/home/z/.venv/bin/python3`)
4. `git config --global core.sshCommand /home/z/.config/cbm/ssh-wrapper.py`
5. Re-add deploy key (project-scoped, write access) on GitLab + GitHub
6. Re-clone from GitHub (faster than GitLab via paramiko for deep fetches)

See `MAINTAINERS_NOTES.local.md` for the actual key path and deploy key value.

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
Using `sed -i 's/0.12.2/0.12.3/g'` across all docs also changes the R55
entry in V2_ROADMAP (which was at version 0.12.2). Always verify after sed:
`grep -rn "<new-version>" docs/V2_ROADMAP.md` and fix historical entries
that shouldn't have been changed.

### Branch protection blocks remote branch deletion
`git push origin --delete v2/round50` fails silently if branch protection
is enabled on GitLab. Delete via GitLab UI instead.
