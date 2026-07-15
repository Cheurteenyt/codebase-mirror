# Repository Instructions

## Repository as the source of truth

- Fix every reproducible application, CLI, MCP, UI, packaging, or platform bug in this repository.
- A local workaround may unblock diagnosis, but it is not the final fix. Completion requires a repository change and a regression test when practical.
- Do not hide failures with permissive flags, ignored exit codes, or machine-specific configuration.
- If evidence shows that a failure belongs to Codex, the operating system, or another dependency rather than this project, record that evidence and keep the repository change narrowly scoped.

## Working-tree safety

- Inspect `git status` before editing and preserve unrelated or concurrent changes.
- Do not reset, restore, delete, or rewrite changes that are not part of the active fix.
- Avoid files with in-progress changes unless the overlapping work has been explicitly coordinated.

## Bug-fix workflow

1. Reproduce the failure with the smallest reliable command or test.
2. Add a regression test that fails for the confirmed cause when practical.
3. Implement the smallest root-cause fix in the repository.
4. Run the targeted regression, TypeScript typecheck, and the relevant build. Run broader suites in an environment that supports their platform requirements.
5. Update user-facing documentation when commands, configuration, compatibility, or behavior changed.
6. Rebuild and reindex Codebase Memory after changes to the indexer or MCP server.

## Platform rules

- Treat Windows as a supported platform for the Node.js CLI and local MCP server.
- Use Node.js path and process APIs (`fileURLToPath`, `path`, `execFile`/`spawn` argument arrays) instead of POSIX shell pipelines in cross-platform TypeScript.
- Do not hard-code `/dev/null`, `chmod`, `ls`, Bash, or extensionless `node_modules/.bin` executables in cross-platform tests.
- Isolate genuinely POSIX-only tests explicitly and keep portable product tests runnable on Windows and Linux.

## Verification commands

Backend and MCP:

```text
cd v2
npm ci
npm run typecheck
npm run build
npx vitest run <target-test-file>
```

Complete package with embedded UI:

```text
cd v2
npm run build:package
```

Frontend:

```text
cd graph-ui
npm ci
npx tsc --noEmit
npm run build
npm test
```

## Definition of done

- The root cause is fixed in tracked repository code.
- A targeted regression protects the behavior, or the reason a test is impractical is documented.
- Relevant typecheck/build/test commands pass on the supported platform.
- The final diff is scoped and does not contain unrelated worktree changes.
