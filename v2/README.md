# Codebase Memory V2

> **Package:** `codebase-memory-v2`
> **Status:** pre-release (not yet published to npm)
> **License:** MIT — see [LICENSE](LICENSE)

Hybrid code intelligence: native WASM indexer (112 languages via tree-sitter),
human memory graph (SQLite), Obsidian sync, and a web-based graph UI.

## Installation

```bash
# From source (development)
git clone https://github.com/Cheurteenyt/Ariad.git
cd Ariad/v2
npm ci

# Choose one build target. Backend CLI + MCP server only:
npm run build

# Or the complete distributable package, including the Graph UI:
# (also installs and builds graph-ui from the repository root)
npm run build:package

# From npm (when published)
npm install -g codebase-memory-v2
```

`npm ci` does not put this package's own `cbm-v2` binary on your `PATH`. From a
source checkout, use `node dist/cli/index.js` as shown below, or run `npm link`
once if you prefer the shorter `cbm-v2` command.

## Quick start

```bash
# Index a project (native WASM indexer — no V1 needed for TS/JS)
node dist/cli/index.js index --project my-app --root /path/to/repo

# Optional reduced-coverage full rebuild; incompatible with --incremental
node dist/cli/index.js index --project my-app --root /path/to/repo --discovery-mode fast

# Start the graph UI (requires npm run build:package)
node dist/cli/index.js ui --project my-app
# Add repositories outside the user's home directory to Control's allowlist
node dist/cli/index.js ui --project my-app --allowed-root /srv/repos

# Start MCP server
node dist/cli/index.js mcp --project my-app
```

## MCP integration

The MCP server exposes 8 tools for code graph queries and human memory CRUD.
Its backward-compatible `lookup_source_text` profiles provide bounded exact
literals, persistent direct-caller aggregation, optional identity-aware
reverse multi-hop callers, bounded route/CLI call chains, and tracked top-level
repository inventory with explicit completeness metadata. Use exact profiles
for exact questions and graph context tools only when relationships, blast
radius, architecture, or human memory affect the task.
Those tools do not synchronize the Obsidian vault; use the separate
`cbm-v2 obsidian ...` commands or `cbm-v2 watch` for vault synchronization.
See the [MCP Tools documentation](https://github.com/Cheurteenyt/Ariad/blob/main/docs/reference/MCP_TOOLS.md)
for the full reference.

To connect Codex over STDIO, add the server to `~/.codex/config.toml` or to a
trusted project's `.codex/config.toml`:

```toml
[mcp_servers.codebase_memory_v2]
command = "node"
args = ["/absolute/path/to/Ariad/v2/dist/cli/index.js", "mcp", "--project", "my-app"]
```

On Windows, edit `%USERPROFILE%\.codex\config.toml` and use an absolute path
with forward slashes, such as
`D:/Mycodex/Ariad/v2/dist/cli/index.js`. Restart Codex, then run
`codex mcp list` or use `/mcp` to confirm that the server is connected.

## Graph UI

The web UI is built from `graph-ui/` and embedded in the package at
`dist/ui/`. It is resolved at runtime via `import.meta.url`, so it works
from any working directory after installation.

```bash
npm run build:package
node dist/cli/index.js ui --project my-app
# Multiple additional roots may follow one variadic option
node dist/cli/index.js ui --project my-app --allowed-root /srv/repos /mnt/work
```

Open `http://127.0.0.1:9749/`, or use
`http://127.0.0.1:9749/?tab=graph&project=my-app` to open the graph directly.
Control can browse and index the user's home directory and the selected
project's indexed root by default. Use `--allowed-root <paths...>` for other
repository trees; the server canonicalizes paths and enforces containment.

The read-only graph API keeps the initial layout bounded while allowing exact
drill-downs across the complete indexed project:

- `GET /api/node-search?project=my-app&q=auth&limit=50` returns ranked literal
  matches with an opaque `page.next_cursor` for the next page.
- `GET /api/neighborhood?project=my-app&node_id=42&limit=100` returns the exact
  inbound/outbound neighborhood with stable edge-id pagination.
- `GET /api/scope?project=my-app&kind=community&key=src/lib&limit=125`
  reconstructs a domain or directory community on demand. Node batches are
  id-ordered; dense internal edges use bounded continuation pages. Every edge
  is emitted with the batch that introduces its highest-id endpoint, so merged
  pages contain no duplicates or dangling links. The first page also carries the
  revision-stable `exact-directory-file-v1` layout for the complete scope: at
  most 12 directory surfaces and 60 file surfaces (48 selected files plus at
  most one aggregate per directory), with exact all-node counts.
- `GET /api/layout?project=my-app&max_nodes=2000` returns the sampled visual
  layout plus `layout.domain_catalog`, whose domain counts and representatives
  cover the complete project rather than only the visual sample.

Layout, exact search, neighborhood, and scope responses include an opaque
`graph_revision`, and each response is read from one SQLite snapshot. Exact
cursors are valid only for that revision. If indexing changes or replaces the
graph between pages, the server responds with HTTP `409`, code
`"GRAPH_REVISION_MISMATCH"`, and `restart_from_first_page: true` instead of
mixing two graph states.

## Node compatibility

- **Runtime:** Node >= 22.12.0
- **CI tested:** Node 22.12.0 on Linux and Windows
- **Recommended development/runtime line:** Node 24 LTS (`.nvmrc` and
  `.node-version` at the repository root)
- **Install/runtime compatibility:** npm 10 and npm 11 (lockfile v3)
- **Repository authoring hint:** `packageManager: npm@10.9.0` for Corepack and
  contributor tooling; it is not an npm runtime constraint
- **Native dependencies:** `better-sqlite3` (requires build tools or
  prebuild-install)

## Links

- [GitHub Repository](https://github.com/Cheurteenyt/Ariad)
- [Documentation Portal](https://github.com/Cheurteenyt/Ariad/blob/main/docs/README.md)
- [Architecture](https://github.com/Cheurteenyt/Ariad/blob/main/docs/architecture/V2_ARCHITECTURE.md)
- [CLI Reference](https://github.com/Cheurteenyt/Ariad/blob/main/docs/reference/CLI_REFERENCE.md)
- [Current State](https://github.com/Cheurteenyt/Ariad/blob/main/docs/reference/V2_CURRENT_STATE.md)
- [Changelog](CHANGELOG.md) — current release window and historical archive link
- [Contributing](https://github.com/Cheurteenyt/Ariad/blob/main/CONTRIBUTING.md)

## Pre-release notice

This package is not yet published to npm. The first public release will
be a pre-release (`v0.78.0-alpha.1`) after atomic generation publication
(R169) and project lease/fencing (R170) are complete.
