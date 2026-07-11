# Contributing to Codebase Memory V2

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Quick Start

```bash
# Clone
git clone https://github.com/Cheurteenyt/codebase-mirror.git
cd cheurteen-project/v2

# Install dependencies
npm install

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

- **Node.js** ≥ 18.6.0 (tested on 22, 24; see `v2/package.json` engines)
- **Python 3** (for `better-sqlite3` native build, or use prebuild-install)
- **Codebase Memory V1** (the C engine) — optional. V2 has a native WASM indexer (112 languages) and is partially autonomous for TS/JS. V1 is a fallback for other languages.

## Project Structure

```
v2/
├── src/
│   ├── indexer/       # Native WASM indexer (discovery, extraction, cross-file resolver)
│   ├── human/          # Human memory DB (SQLite, CRUD, schema)
│   ├── obsidian/       # Vault sync (generator, importer, frontmatter, wikilinks)
│   ├── bridge/         # Read-only access to code graph (V1 or V2 native)
│   ├── mcp/            # MCP server + 7 tools
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
git checkout -b v2/r<n>-<short-name>
# Example: v2/r143-persistent-discovery-state
```

### 2. Implement + test

```bash
npm run typecheck      # tsc --noEmit
npm run build          # clean + tsc
npm test               # pretest (build) + vitest run
```

The full suite must pass with 0 regressions. See `v2/CHANGELOG.md` for the current test count.

### 3. Update docs

- `v2/CHANGELOG.md` — add a round entry with bugs fixed, tests added
- `v2/package.json` — bump version (patch for hotfix, minor for feature)
- `README.md` / `docs/` — update if architecture or CLI changed
- `docs/V2_CURRENT_STATE.md` — update if stable features or limitations changed

### 4. Commit + push

```bash
git add -A
git commit -m "fix(v2): R<n> <short description> — <priority summary>"
git push -u origin v2/r<n>-<short-name>
```

### 5. Open a Pull Request on GitHub

Open a Pull Request on GitHub from `v2/r<n>-<short-name>` to `main`.
GitHub Actions CI runs typecheck, build, and tests on the PR.
After CI is green and review is complete, the PR is merged into `main`.

## Testing

- **Indexer tests**: `v2/tests/indexer/` — `r<n>-*.test.ts` per round
- **MCP tests**: `v2/tests/mcp/` — spawns `dist/cli/index.js` (requires build)
- **Graph UI tests**: `graph-ui/` — Vitest + @testing-library/react
- **Permission tests**: chmod 000 tests require non-root user

## CI/CD

GitHub is the canonical repository since R166. All CI, pull-request
validation, reviews, and merges happen on GitHub Actions.

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
- No lockfile (dependency drift risk)
- Node 20 EOL in 2026

See [MAINTAINERS_GUIDE.md](MAINTAINERS_GUIDE.md) for the full workflow and invariants.

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

## CI/CD

The project uses a **GitLab → GitHub mirror** setup (GitHub Actions has unlimited
minutes for public repos; GitLab free tier is limited).

### Pipeline flow
1. Push to a feature branch on GitLab → MR pipeline runs `mr-preflight` (R54)
2. Merge to `main` on GitLab → `mirror-to-github` job pushes to GitHub
3. GitHub Actions CI runs 3 jobs: `backend` (typecheck+build+test),
   `frontend` (same), `quota-report` (schedule-only, R55 D5)

### Install command
The project uses `npm install --no-audit --no-fund` (not `npm ci`) because
`package-lock.json` is gitignored (platform-specific lockfiles). See
`.gitignore` for the rationale.

### Required checks before merge
```bash
cd v2 && npm run build && npx vitest run     # see v2/CHANGELOG.md for current test count
cd ../graph-ui && npx tsc --noEmit && npx vitest run  # 23 frontend tests
```
All tests must pass with 0 regressions. A failed pipeline blocks merge.
See `v2/CHANGELOG.md` for the current test count (R153: 418 indexer tests + 773 project tests).

See `MAINTAINERS_GUIDE.md` for the full workflow (SSH setup, deploy keys,
branch protection, MR push options, etc.).

## Release Process

1. Update `package.json` version
2. Update `CHANGELOG.md` with the new version entry
3. Run `npm run prepublishOnly` (typecheck + test)
4. Create a tag: `git tag v0.X.0`
5. Push: `git push origin v0.X.0`

## Questions?

- Open an issue on GitHub: https://github.com/Cheurteenyt/codebase-mirror/issues
- Read the docs: `docs/` directory
- Check the CHANGELOG: `v2/CHANGELOG.md`
