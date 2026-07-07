# Maintainers Guide — Codebase Memory V2

> Internal conventions, workflow patterns, and "do/don't" rules accumulated
> across 55 audit rounds. Public doc (no sensitive info) — for SSH key paths,
> runner IPs, or other secrets, see your local `MAINTAINERS_NOTES.local.md`
> (gitignored).

## Workflow: audit → implement → test → docs → commit → push → MR

The canonical workflow for every change (audit fix, new feature, bug fix):

1. **Audit** — read the audit report carefully. Verify each finding against
   the actual codebase before implementing (don't trust the report blindly —
   audit reports have been wrong before, e.g. flagging code that was already
   fixed in a previous round).
2. **Implement** — make the minimal change that fixes the issue. Don't
   refactor unrelated code in the same commit.
3. **Test** — run `npm run build && npx vitest run` in both `v2/` and
   `graph-ui/`. The full suite (376 tests: 353 backend + 23 frontend) must
   pass with 0 regressions before committing.
4. **Docs** — update in parallel: CHANGELOG.md entry, version bump in
   package.json, README/docs version refs, V2_ROADMAP round entry + metrics.
5. **Commit** — one commit per round (e.g. R55). Message format:
   `fix(v2): 0.12.2 R55 Claude Sonnet R9 audit (4 fixes, Part A + D3 + D4 + D5)`
6. **Push** — `git push origin v2/r<n>-<short-name> -o merge_request.create
   -o merge_request.target=main -o merge_request.title="..."` (single line,
   no newlines in push options).
7. **MR** — GitLab MR with `mr-preflight` job (R54) passes in ~2s. Merge
   → mirror auto → GitHub Actions CI (3 jobs: backend, frontend, quota-report).

## Naming conventions

- **R<n>** — round number (R44, R45, ..., R55). One per audit/fix cycle.
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
  - Currently 0.12.2 (R55).
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

See `docs/V2_ROADMAP.md` for the full history (R1 → R55).
