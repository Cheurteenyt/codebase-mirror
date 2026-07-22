# Contributing to Codebase Memory V2

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Quick Start

```bash
# Clone
git clone https://github.com/Cheurteenyt/Ariad.git
cd Ariad/v2

# Install the committed dependency graph
npm ci

# Build (cleans dist/ first to avoid stale artifacts)
npm run build

# Run tests (builds first via pretest hook)
npm test

# Run in dev mode (no build needed)
npm run dev -- --help

# Index a project natively (no V1 needed for TS/JS)
npm run dev -- index --project my-app --root /path/to/repo
```

## Prerequisites

- **Node.js** ≥ 22.12.0 (CI verifies the exact floor; `nvm use` selects Node 24 LTS)
- **npm** 10 or 11. The `packageManager: npm@10.9.0` fields are repository-authoring/Corepack hints, not runtime constraints.
- **Python 3** (for `better-sqlite3` native build, or use prebuild-install)
- **Codebase Memory V1** (the C engine) — optional and run separately. V2 never invokes it as a fallback; it can read a compatible database that V1 produced in a separate run.

## Project Structure

```
v2/
├── src/
│   ├── indexer/       # Native WASM indexer (discovery, extraction, cross-file resolver)
│   ├── human/          # Human memory DB (SQLite, CRUD, schema)
│   ├── obsidian/       # Vault sync (generator, importer, frontmatter, wikilinks)
│   ├── bridge/         # Read-only access to code graph (V1 or V2 native)
│   ├── mcp/            # MCP server + 8 tools
│   ├── intelligence/   # Graph status, freshness, SWR cache
│   ├── cli/            # CLI commands (commander-based, including `index`)
│   ├── reports/        # Hotspots, undocumented, risk reports
│   ├── ui/             # Graph UI backend (routes, WebSocket)
│   ├── utils/          # Shared utilities (safe-path.ts)
│   ├── config.ts       # .codebase-memory.json loader
│   └── constants.ts    # Shared constants (no magic numbers)
├── tests/              # Vitest test files (see v2/CHANGELOG.md for current count)
├── docs/               # Design documents and current state
├── scripts/            # Benchmarks and debug tools
├── package.json
└── tsconfig.json
```

## Native Indexer

V2 includes a native code indexer (`v2/src/indexer/`) that does NOT require V1:

- **`wasm-extractor.ts`** — tree-sitter WASM parsing, discovery (`discoverSourceFilesStructured`), language detection
- **`fast-walker.ts`** — AST walker for exports, imports, call-sites
- **`cross-file-resolver.ts`** — matches call-sites to definitions across files
- **`indexer.ts`** — orchestrator: full/incremental, parallel workers, semantic versioning
- **`schema.ts`** — SQLite schema, `CURRENT_EXTRACTOR_SEMANTICS_VERSION = 8`
  (R144+). R153 added `alias_history` table for historical-target protection.
- **`worker.ts`** — worker thread for parallel WASM parsing

Key invariants (see [MAINTAINERS_GUIDE.md](MAINTAINERS_GUIDE.md)):
- Partial discovery preserves the existing graph (no silent wipe)
- Canonical root is propagated to all downstream operations
- Stale flag is persisted in DB and read by Graph Status
- Semantics version bump forces full reindex when extractor output changes

## Development Workflow

### 1. Create a branch

```bash
git switch -c v2/r<n>-<short-name>
# Example: v2/r143-persistent-discovery-state
```

For work performed in a reset-prone AI environment, follow
[AI_COLLABORATION_PROTOCOL.md](docs/operations/AI_COLLABORATION_PROTOCOL.md). Create
`docs/ai/CURRENT_HANDOFF.md` from the GLM handoff template on the work branch
and push checkpoints frequently. At rest only `main` remains; one work branch
is allowed during an active round.

### 2. Implement + test

```bash
npm run typecheck      # tsc --noEmit
npm run build          # clean + tsc
npm run docs:check     # links, anchors, metadata, organization, reachability
npm test               # pretest (build) + vitest run
```

The full suite must pass with 0 regressions. See `v2/CHANGELOG.md` for the current test count.

### 3. Update docs

- `v2/CHANGELOG.md` — add a round entry with bugs fixed, tests added
- `v2/package.json` — bump version (patch for hotfix, minor for feature)
- `README.md` / `docs/` — update if architecture or CLI changed
- `docs/reference/V2_CURRENT_STATE.md` — update if stable features or limitations changed
- `docs/README.md` — register any new canonical document; prefer updating an
  existing authority over creating a competing overview

### 4. Commit + push

```bash
git add -A
git commit -m "fix(v2): R<n> <short description> — <priority summary>"
git push -u origin v2/r<n>-<short-name>
```

Every push to `v2/**` triggers the complete GitHub Actions gate, even before a
PR exists. The latest pushed SHA must be green; older pending runs may be
replaced by newer checkpoints. Verify the remote head after each
reset-recovery checkpoint; a local test result is not equivalent to a green
GitHub run on the pushed SHA.

### 5. Open a Pull Request on GitHub

Open a Pull Request on GitHub from `v2/r<n>-<short-name>` to `main`.
Use exactly one PR for the round. It may be opened as a draft for durable
discussion, or during final review to avoid duplicate branch-push and PR runs.
GitHub Actions CI runs typecheck, build, tests, package smoke, and Docker smoke.
After CI is green and review is complete, the PR is merged into `main`.

## Testing

- **Indexer tests**: `v2/tests/indexer/` — `r<n>-*.test.ts` per round
- **MCP tests**: `v2/tests/mcp/` — spawns `dist/cli/index.js` (requires build)
- **Graph UI tests**: `graph-ui/` — Vitest + @testing-library/react
- **Permission tests**: chmod 000 tests require non-root user

## CI/CD

GitHub is the canonical repository since R166. All branch-checkpoint CI,
pull-request validation, reviews, and merges happen on GitHub Actions.

- **Backend (v2)**: typecheck, build, tests, benchmark smoke
- **Frontend (graph-ui)**: typecheck, build, tests
- **Mirror**: after CI on `main` is green, the `mirror-main-to-gitlab`
  workflow fast-forwards the validated SHA to GitLab `main` with
  `-o ci.no_pipeline`. GitLab is a passive main-only mirror and runs no
  pipelines.

Standard GitHub-hosted runners are free for public repositories; larger
runners and storage follow separate billing/limits.

Known gaps:
- No Windows/macOS matrix (PKG-CARRY-01)

See [MAINTAINERS_GUIDE.md](MAINTAINERS_GUIDE.md) for the full workflow and invariants.
See [AI_COLLABORATION_PROTOCOL.md](docs/operations/AI_COLLABORATION_PROTOCOL.md) for
external audit handoff and environment-reset recovery.

## Code Style Guidelines

### TypeScript

- `strict: true` in tsconfig — no implicit `any`, no implicit `undefined`
- Prefer `interface` over `type` for object shapes
- Use `as const` for readonly arrays
- Avoid `!` (non-null assertion) — handle `null`/`undefined` explicitly
- Use `try/catch` around all `JSON.parse` calls (use `safeJsonParse` from `constants.ts`)

### Error Handling

- **Never** use `process.exit()` inside `try/finally` blocks — use `process.exitCode` + `return`
- Error messages must be actionable: include what's wrong AND how to fix it
- Example: `Error: invalid status "weird". Valid: draft, active, reviewed, deprecated`

### Database

- All multi-step writes must be wrapped in `db.transaction()`
- Always set `busy_timeout = 5000` on SQLite connections
- Use parameterized queries (never string concatenation in SQL)
- Validate all user input before INSERT (labels, statuses, paths)

### File System

- Validate `obsidian_path` against path traversal (`..` and backslashes)
- Use `mkdirSync(path, { recursive: true })` without `existsSync` check
- Cap backups to `MAX_BACKUPS_PER_FILE` (5)
- Walk vaults iteratively with depth limit (32) and symlink loop detection

## Testing Guidelines

### Test file placement

```
tests/
├── human/           # HumanMemoryStore tests
├── obsidian/        # Frontmatter, wikilinks, vault, sync tests
├── mcp/             # MCP server protocol tests
├── reports/         # Report computation tests (planned)
└── config.test.ts   # Config loader tests
```

### Test patterns

```typescript
// Use in-memory DB for unit tests
const store = HumanMemoryStore.openMemory();

// Use mkdtempSync for filesystem tests
const tmpDir = mkdtempSync(join(tmpdir(), 'cbm-test-'));
// ... test ...
rmSync(tmpDir, { recursive: true, force: true });

// Test both happy and error paths
it('creates a node', () => { ... });
it('rejects invalid label', () => { ... });
```

## Adding a New MCP Tool

1. Create `src/mcp/tools/your_tool.ts`:
   ```typescript
   export class YourTool extends BaseTool {
     get definition(): ToolDefinition { ... }
     async handle(args: Record<string, unknown>) { ... }
   }
   ```

2. Add to `src/mcp/tools/index.ts` → `TOOL_CLASSES` array

3. Add a test in `tests/mcp/server.test.ts`

## Adding a New Human Node Label

Currently requires editing 5 files (single source of truth not yet implemented):
1. `src/human/schema.ts` → `HUMAN_NODE_LABELS` array
2. `src/human/schema.ts` → SQL CHECK constraint
3. `src/obsidian/frontmatter.ts` → `mapLabelToType` switch
4. `src/obsidian/importer.ts` → `inferLabelFromFrontmatter` map
5. `src/human/schema.ts` → `obsidianPathFor` switch

## Required checks before merge

GitHub is the canonical repository since R166. See the `## CI/CD` section
near the top of this document for the architecture. Standard GitHub-hosted
runners are free for public repositories; larger runners and storage
follow separate billing/limits.

```bash
cd v2 && npm run docs:check && npm run build && npx vitest run
cd ../graph-ui && npx tsc --noEmit && npx vitest run
```
All tests must pass with 0 regressions. A failed pipeline blocks merge.
See `v2/CHANGELOG.md` for the current test count.

## Dependency updates

Dependabot opens grouped weekly minor/patch updates for GitHub Actions, the V2
backend, Graph UI, and Docker, and ignores semver-major version updates. Major
updates remain deliberate migrations because the
native SQLite binding, Vite, TypeScript, and UI libraries can change runtime or
build contracts. Before merging an update PR, run:

```bash
cd v2 && npm ci && npm audit && npm run typecheck && npm test
cd ../graph-ui && npm ci && npm audit && npm run build && npm test
```

Lockfiles are authoritative and must be committed with dependency changes.
`npm outdated` is informational: a newer major version is not automatically a
safe update.

See `MAINTAINERS_GUIDE.md` for the full workflow (SSH setup, deploy keys,
branch protection, GitHub PR push options, etc.).

## Release Process

Public releases are not automated yet. Follow
[`docs/operations/RELEASE_POLICY.md`](docs/operations/RELEASE_POLICY.md); do not create or push a tag
until its full-CI, packed-install/UI, Docker/UI, release-note, and checksum
gates have been completed on the exact release commit. At minimum:

1. Update `v2/package.json`, its lockfile, and `v2/CHANGELOG.md`.
2. Run the complete backend/frontend validation and smoke benchmarks.
3. Build and install the npm tarball from a temporary directory; verify CLI
   and UI behavior from an unrelated working directory.
4. Build the Docker image without cache and verify CLI, non-root cache access,
   and the UI HTTP endpoint.
5. Create and push the immutable `v<version>` tag only after those gates pass.
6. Publish release notes and checksums; never force-push a release tag.

## Questions?

- Open an issue on GitHub: https://github.com/Cheurteenyt/Ariad/issues
- Read the docs: `docs/` directory
- Check the CHANGELOG: `v2/CHANGELOG.md`
