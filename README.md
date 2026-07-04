# Codebase Memory V2 — cheurteen-project

Implementation of Codebase Memory V2 — adding a **human memory layer** (ADR, BugNote, RefactorPlan, Convention, etc.) and **Obsidian vault sync** on top of the existing Codebase Memory MCP V1 (C11 engine + React/Three.js UI).

## What's in this repo

```
.
├── README.md                     ← this file
├── docs/                         ← V2 design documents
│   ├── V2_AUDIT.md
│   ├── V2_ARCHITECTURE.md
│   ├── V2_ROADMAP.md
│   ├── OBSIDIAN_INTEGRATION.md
│   └── HUMAN_MEMORY_GRAPH_SCHEMA.md
├── v2/                           ← V2 TypeScript sidecar (MVP)
│   ├── package.json
│   ├── tsconfig.json
│   ├── README.md
│   ├── CHANGELOG.md
│   ├── src/
│   │   ├── human/                ← Human memory DB (schema, store)
│   │   ├── obsidian/             ← Vault generator + sync + importer
│   │   ├── bridge/               ← Read-only access to V1 code graph
│   │   ├── reports/              ← hotspots, undocumented, risk
│   │   ├── mcp/                  ← MCP server + 6 tools
│   │   └── cli/                  ← cbm-v2 CLI
│   └── tests/                    ← 10 passing tests
└── v1-reference/                 ← V1 source (for reference, NOT to build)
    ├── src/                      ← C engine source (foundation, mcp, store, pipeline, etc.)
    ├── README-V1.md
    └── Makefile.cbm
```

## Quick start

```bash
cd v2
npm install
npm run build
npm test                    # 10 tests pass

# Use the CLI
node dist/cli/index.js --help
node dist/cli/index.js init --project my-app
node dist/cli/index.js obsidian init
node dist/cli/index.js obsidian sync --project my-app
node dist/cli/index.js human create --project my-app --type ADR --title "ADR-001: ..."
node dist/cli/index.js report hotspots --project my-app

# Use as MCP server
node dist/cli/index.js mcp --project my-app
```

## Status — MVP

- ✅ Human memory graph (SQLite)
- ✅ Obsidian vault sync (with HUMAN NOTES preserved — regression-tested)
- ✅ 6 MCP tools (out of 15 planned)
- ✅ 3 reports (hotspots, undocumented, risk)
- ✅ CLI commands (obsidian, human, report, init, mcp)
- ✅ 10 tests passing
- ⏳ 9 more MCP tools (V1 complète)
- ⏳ UI changes (V1 complète)
- ⏳ Plugin system (V2 étendue)

See `docs/V2_ROADMAP.md` for the full roadmap.

## Documentation

- [V2 Audit](docs/V2_AUDIT.md) — Analysis of V1 (C11 codebase, 65K LOC)
- [V2 Architecture](docs/V2_ARCHITECTURE.md) — Sidecar TypeScript design
- [V2 Roadmap](docs/V2_ROADMAP.md) — MVP → V1 → V2 phases
- [Obsidian Integration](docs/OBSIDIAN_INTEGRATION.md) — Vault format and sync
- [Human Memory Schema](docs/HUMAN_MEMORY_GRAPH_SCHEMA.md) — SQL schema

## Branch

This MVP is on branch `v2/code-human-memory`. The default `main` branch is empty (initial state).

## License

MIT (same as the upstream [Codebase Memory MCP](https://github.com/DeusData/codebase-memory-mcp)).
