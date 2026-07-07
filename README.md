# Codebase Memory V2

> Human memory graph + Obsidian vault sync for [Codebase Memory MCP](https://github.com/DeusData/codebase-memory-mcp).
> Adds ADRs, bug notes, refactor plans, conventions, and more — layered on top of the C engine's code graph.

[![CI](https://github.com/Cheurteenyt/codebase-mirror/actions/workflows/ci.yml/badge.svg)](https://github.com/Cheurteenyt/codebase-mirror/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What is this?

Codebase Memory V1 understands the **structure** of your code (functions, modules, routes, 158 languages via tree-sitter).

Codebase Memory V2 adds the **human context**:
- Architecture Decision Records (ADRs)
- Known bugs and their impact
- Refactor plans
- Coding conventions
- Legacy zone markers
- Risk assessments
- Activity journal

It syncs everything to an **Obsidian-compatible Markdown vault** so you can read and edit notes in your favorite editor, with backlinks and tags.

## Current version: 0.14.0

- **378 tests** (355 backend + 23 frontend, all passing)
- **7 MCP tools** (including the flagship `prepare_edit_context`)
- **16+ CLI commands** across 7 command groups (including `watch` daemon)
- **15 API endpoints** (6 original + 9 R17)
- **565+ bugs fixed across 68 audit rounds**
- **Graph UI** with 2D d3-force canvas, dashboard, filters, **real-time WebSocket**, ARIA tablist, stale-while-revalidate refetch, AbortController timeouts
- **Watch daemon** — auto-sync when vault files change (fs.watch recursive)
- **FTS5 full-text search** on human notes (BM25 ranking, AND-of-terms, migration V4)
- **Hardened API** — project_name validation + `--` separator, process-kill allowlist (cbm/cbm-v2 only), browse restricted to home (realpath-resolved), project-health path-traversal guard
- **Transactional writes** — updateNode/deleteNode/createEdge/syncCbmLinks wrapped in transactions (atomicity guarantee)
- **N+1 elimination** — getBulkNeighbors in prepare_edit_context (40→3 queries), generator module/route export (200+→6 queries), routeDashboard reuses SWR-cached counts
- **Frontend test infrastructure** — Vitest + @testing-library/react + jsdom (21 tests covering C1 regression, WS zombie race, sim reuse, viewport flip, pointer cancel, kill confirmation, corrupt-state gate)
- **Optimized SQLite storage** (junction table, composite indexes, FTS5, PRAGMAs)

## Quick start

```bash
cd v2
npm install
npm run build
npm test                    # 378 tests

# Try the demo (no V1 needed)
node dist/cli/index.js demo

# Initialize your project
node dist/cli/index.js init --project my-app

# Run diagnostics
node dist/cli/index.js doctor --project my-app

# Start the graph UI (http://127.0.0.1:9749)
node dist/cli/index.js ui --project my-app
```

## CLI reference

### Core commands

| Command | Description |
|---|---|
| `cbm-v2 init` | Initialize `.codebase-memory.json` configuration |
| `cbm-v2 doctor` | Run diagnostics (Node version, DB, vault path) |
| `cbm-v2 stats` | Show a pretty statistics dashboard |
| `cbm-v2 demo` | Create a demo project with sample notes + vault |
| `cbm-v2 mcp` | Run as MCP server (JSON-RPC over stdio) |
| `cbm-v2 ui` | Start the graph UI web server (port 9749) |
| `cbm-v2 watch` | Watch vault for changes and auto-sync (daemon) |

### Human memory commands

| Command | Description |
|---|---|
| `cbm-v2 human create --type ADR --title "ADR-001: ..."` | Create a note |
| `cbm-v2 human list [--type ADR] [--status active]` | List notes |
| `cbm-v2 human show <id>` | Show a note (JSON, includes edges) |
| `cbm-v2 human link <noteId> --to-cbm-node <id> --edge DECIDES` | Link note to code node |

### Obsidian commands

| Command | Description |
|---|---|
| `cbm-v2 obsidian init` | Create vault directory structure |
| `cbm-v2 obsidian sync` | Bidirectional sync (DB ↔ vault) |
| `cbm-v2 obsidian sync --dry-run` | Preview without writing |
| `cbm-v2 obsidian sync --direction export` | Export only (DB → vault) |
| `cbm-v2 obsidian sync --direction import` | Import only (vault → DB) |
| `cbm-v2 obsidian export` | One-shot export (DB → vault) |
| `cbm-v2 obsidian import` | One-shot import (vault → DB) |
| `cbm-v2 obsidian report` | Vault file report (by directory) |
| `cbm-v2 obsidian create-adr --title "ADR-003: ..."` | Create ADR + DB record |
| `cbm-v2 obsidian create-module-note --module auth` | Create ModuleNote |
| `cbm-v2 obsidian create-route-note --method POST --path /api/login` | Create RouteNote |

### Report commands

| Command | Description |
|---|---|
| `cbm-v2 report hotspots` | Critical modules (high degree + complexity) |
| `cbm-v2 report undocumented` | Code nodes without human notes |
| `cbm-v2 report risk` | High coupling, dead code, fragile interfaces |

### Backup commands

| Command | Description |
|---|---|
| `cbm-v2 backup export --output backup.json` | Export all notes + edges to JSON |
| `cbm-v2 backup import backup.json` | Import from JSON backup |
| `cbm-v2 backup import backup.json --dry-run` | Preview import |

## MCP tools (7)

The `cbm-v2 mcp` command exposes 7 tools via JSON-RPC 2.0 over stdio:

| Tool | Type | Description |
|---|---|---|
| `get_project_overview` | read | High-level project stats (nodes, notes, coverage, freshness) |
| `get_module_context` | read | Full module context: code + human notes + ADRs + bugs + refactors |
| `get_undocumented_hotspots` | read | Critical code nodes without documentation |
| `create_human_note` | write | Create ADR/BugNote/etc. + link to code nodes |
| `link_note_to_code_node` | write | Link existing note to a code node |
| `search_code_and_memory` | read | Unified search across code graph + human memory |
| `prepare_edit_context` ⭐ | read | **Flagship** — call BEFORE editing any file. Returns code structure, dependencies, human notes, blast radius, risk score, freshness, and recommendations |

### Connecting an AI agent

Add to your MCP client config (Claude Desktop, Cursor, Zed, etc.):

```json
{
  "mcpServers": {
    "codebase-memory-v2": {
      "command": "node",
      "args": ["/path/to/v2/dist/cli/index.js", "mcp", "--project", "my-app"]
    }
  }
}
```

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│  Codebase Memory V2                                          │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌─────────────────────┐    ┌──────────────────────────┐   │
│   │  C Engine (V1)      │    │  TS Sidecar (V2)         │   │
│   │  tree-sitter 158    │    │  Human Memory DB         │   │
│   │  SQLite code graph  │◄───┤  Obsidian vault sync     │   │
│   │  14 MCP tools (V1)  │    │  7 MCP tools (V2)        │   │
│   │                     │    │  Graph UI (d3-force 2D)  │   │
│   └─────────────────────┘    └──────────────────────────┘   │
│                                                              │
│   Storage:                                                   │
│   ~/.cache/codebase-memory-mcp/                              │
│     <project>.db           ← code graph (V1, C)             │
│     <project>.human.db     ← human memory (V2, TS)          │
│   <repo>/.codebase-memory-vault/  ← Obsidian vault (MD)     │
│   <repo>/.codebase-memory.json    ← project config          │
└──────────────────────────────────────────────────────────────┘
```

## Human memory node types

| Label | Obsidian dir | Description |
|---|---|---|
| `ArchitectureNote` | `Architecture/` | Transverse architecture notes |
| `ADR` | `ADR/` | Architecture Decision Records |
| `BugNote` | `Bugs/` | Known bugs |
| `RefactorPlan` | `Refactor/` | Planned refactors |
| `LegacyNote` | `Legacy/` | Legacy zone markers |
| `Convention` | `Conventions/` | Coding/architecture conventions |
| `Prompt` | `Prompts/` | Useful prompts for AI agents |
| `JournalEntry` | `Journal/` | Activity journal |
| `ModuleNote` | `Modules/` | Notes attached to modules |
| `RouteNote` | `Routes/` | Notes attached to HTTP routes |
| `RiskNote` | `Architecture/` | Risk assessments |

## Vault format

Each note has two sections:

```markdown
---
type: adr
status: active
cbm_node_ids: [1234]
tags: [auth, security]
---

# ADR-001: Use JWT for authentication

## AUTO-GENERATED

> ⚠️ This section is controlled by Codebase Memory V2 and may be regenerated.
> Do not edit — your changes would be lost on the next sync.

### Metadata
- **Type**: ADR
- **Status**: active
- **Slug**: adr-001-use-jwt-for-authentication

### Links to code
- [[1234]] — Module:auth (`src/auth/index.ts:1`)

---

## HUMAN NOTES

> ✏️ This section belongs to the user. It will **never** be overwritten.

### Context
We needed a stateless auth mechanism.

### Decision
Use JWT tokens signed with HS256.
```

The `## HUMAN NOTES` section is **never** overwritten by V2. Edit it freely in Obsidian — the next sync preserves your edits.

## Graph UI

The V2 graph UI replaces V1's 3D Three.js scene with a cleaner 2D d3-force canvas:

- **Dashboard tab** (default): KPIs, graph freshness, smart recommendations
- **Graph tab**: 2D force-directed canvas with filters, pan/zoom, node detail panel
- **Projects tab**: Project list with node/edge counts and health status
- **Control tab**: System info

```bash
cbm-v2 ui --project my-app          # http://127.0.0.1:9749
cbm-v2 ui --project my-app --port 8080
```

## Docker

```bash
# Build
docker build -t cbm-v2 .

# Run CLI
docker run --rm cbm-v2 --help
docker run --rm cbm-v2 demo

# Run MCP server (mount cache volume)
docker run --rm -i -v cbm-cache:/root/.cache/codebase-memory-mcp cbm-v2 mcp --project my-app
```

## Documentation

### Design Documents
- [V2 Audit](docs/V2_AUDIT.md) — Analysis of V1 (C11 codebase, 65K LOC)
- [V2 Architecture](docs/V2_ARCHITECTURE.md) — Sidecar TypeScript design
- [V2 Roadmap](docs/V2_ROADMAP.md) — Current state + roadmap (updated 0.8.2)
- [Obsidian Integration](docs/OBSIDIAN_INTEGRATION.md) — Vault format and sync
- [Human Memory Schema](docs/HUMAN_MEMORY_GRAPH_SCHEMA.md) — SQL schema

### Reference
- [MCP Tools](docs/MCP_TOOLS.md) — All 7 MCP tools with input/output examples
- [CLI Reference](docs/CLI_REFERENCE.md) — All 15+ CLI commands with examples
- [Intelligence Layer](docs/INTELLIGENCE.md) — Graph awareness + prepare_edit_context
- [Token Economy](docs/TOKEN_ECONOMY.md) — How V2 saves API tokens (-67% to -87%)

### Project
- [Contributing](CONTRIBUTING.md) — How to contribute
- [License](LICENSE) — MIT

## Security

- **Local-first**: no network calls, no telemetry
- **HUMAN NOTES preserved**: the `## HUMAN NOTES` section is never overwritten (regression-tested)
- **Path traversal protection**: `obsidian_path` validated against `..` and backslashes
- **Backup rotation**: max 5 `.bak` files per note
- **Dry-run**: available on `obsidian sync`, `obsidian export`, `obsidian import`, `backup import`
- **Consistent sync hashes**: `markSynced` computes the same DB-derived hash for both export and import directions, making conflict detection reliable (R14 fix)

## Performance

- **N+1 query elimination**: all hot paths use bulk fetches (`getBulkNotesByCbmNodeIds`, `getBulkNodeDegrees`, `getBulkEdges`)
- **SQL-level limit**: `getBulkNotesByCbmNodeIds` uses `ROW_NUMBER() OVER (PARTITION BY ...)` to cap per-node at the database level
- **Stable UI listeners**: `GraphCanvas` uses refs for callbacks — no listener rebinds on filter toggle
- **Cursor-following tooltip**: `NodeTooltip` tracks mouse position
- **Zoom-to-mouse**: `GraphCanvas` zoom centers on the cursor, not the origin

## License

MIT — see [LICENSE](LICENSE).
