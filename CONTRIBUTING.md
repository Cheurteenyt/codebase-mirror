# Contributing to Codebase Memory V2

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Quick Start

```bash
# Clone
git clone https://github.com/Cheurteenyt/codebase-mirror.git
cd cheurteen-project/v2

# Install dependencies
npm install

# Build
npm run build

# Run tests (builds first via pretest hook)
npm test

# Run in dev mode (no build needed)
npm run dev -- --help
```

## Prerequisites

- **Node.js** ≥ 18 (tested on 18, 20, 22, 24)
- **Python 3** (for `better-sqlite3` native build, or use prebuild-install)
- **Codebase Memory V1** (the C engine) — optional, only needed for code graph features

## Project Structure

```
v2/
├── src/
│   ├── human/          # Human memory DB (SQLite, CRUD, schema)
│   ├── obsidian/       # Vault sync (generator, importer, frontmatter, wikilinks)
│   ├── bridge/         # Read-only access to V1 code graph
│   ├── mcp/            # MCP server + 7 tools
│   ├── cli/            # CLI commands (commander-based)
│   ├── reports/        # Hotspots, undocumented, risk reports
│   ├── config.ts       # .codebase-memory.json loader
│   └── constants.ts    # Shared constants (no magic numbers)
├── tests/              # Vitest test files (378 tests: 355 backend + 23 frontend)
├── docs/               # Design documents (9 files)
├── examples/           # Sample vault and demo data
├── package.json
└── tsconfig.json
```

## Development Workflow

### 1. Create a branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/issue-description
```

### 2. Make changes

Follow the existing code style:
- **TypeScript strict mode** (no `any` unless absolutely necessary)
- **ESM modules** (`"type": "module"` — use `import/export`, not `require`)
- **No magic numbers** — add to `src/constants.ts`
- **Error messages** must include the offending value and valid options
- **Tests** — every bug fix must include a regression test

### 3. Test

```bash
# Type-check
npm run typecheck

# Build
npm run build

# Run all tests
npm test

# Run a specific test file
npx vitest run tests/human/store.test.ts

# Watch mode
npm run test:watch
```

### 4. Commit

Use conventional commit messages:

```
feat(v2): add backup command
fix(v2): handle empty title in updateNode
docs(v2): update README with all CLI commands
test(v2): add computeRiskScore tests
refactor(v2): decompose generateVault into helpers
```

### 5. Push and create a Merge Request

```bash
git push origin feature/your-feature-name
```

Then create a PR on GitHub. Include:
- What changed and why
- Test results (`npm test` output)
- Breaking changes (if any)

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
cd v2 && npm run build && npx vitest run     # 355 backend tests
cd ../graph-ui && npx tsc --noEmit && npx vitest run  # 23 frontend tests
```
All 378 tests must pass with 0 regressions. A failed pipeline blocks merge.

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
