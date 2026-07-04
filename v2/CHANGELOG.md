# Changelog — Codebase Memory V2

## 0.1.0 — MVP (2026-07-04)

### Added
- **Human Memory Graph** (`v2/src/human/`): SQLite-backed store with 11 node labels (ADR, BugNote, RefactorPlan, Convention, etc.) and 12 edge types (EXPLAINS, DECIDES, AFFECTS, TOUCHES, RISKS, etc.)
- **Obsidian Vault Sync** (`v2/src/obsidian/`):
  - `obsidian init` — creates vault structure (Architecture/, ADR/, Modules/, Routes/, Refactor/, Bugs/, Legacy/, Conventions/, Prompts/, Journal/)
  - `obsidian sync` — bidirectional sync DB ↔ vault
  - `obsidian sync --dry-run` — preview without writing
  - `obsidian export` / `obsidian import` — one-shot operations
  - `obsidian create-adr` / `create-module-note` / `create-route-note`
  - **HUMAN NOTES sections are NEVER overwritten** (regression-tested)
  - Auto-generated module and route notes for high-degree nodes
  - Backup `.bak.<timestamp>` before every write
- **Bridge to V1 Code Graph** (`v2/src/bridge/sqlite-ro.ts`): read-only access to V1 SQLite DB
- **6 MCP Tools** (`v2/src/mcp/tools/`):
  - `get_project_overview` — high-level project stats
  - `get_module_context` — full module context (code + human memory)
  - `get_undocumented_hotspots` — critical code nodes without notes
  - `create_human_note` — create ADR/BugNote/etc. + links in one call
  - `link_note_to_code_node` — add edges to existing notes
  - `search_code_and_memory` — unified search across both graphs
- **CLI Reports** (`v2/src/reports/`):
  - `report hotspots` — critical modules by degree + complexity
  - `report undocumented` — coverage by label, top undocumented critical nodes
  - `report risk` — high coupling, dead code, fragile interfaces, central functions
- **MCP Server** (`v2/src/mcp/server.ts`): JSON-RPC 2.0 over stdio
- **Configuration** (`.codebase-memory.json`): `cbm-v2 init` generates default config
- **Tests**: 10 tests passing, including CRITICAL human-notes-preserved regression test
- **Documentation**: 5 docs in `docs/` (V2_AUDIT, V2_ARCHITECTURE, V2_ROADMAP, OBSIDIAN_INTEGRATION, HUMAN_MEMORY_GRAPH_SCHEMA)

### Architecture Decision
V2 is implemented as a **TypeScript sidecar** on top of the existing C engine (V1), not a rewrite. The C engine handles code memory (tree-sitter indexing, SQLite graph), while V2 adds the human memory layer (ADR, BugNote, RefactorPlan, etc.) and Obsidian sync. Communication is via SQLite read-only access and (optionally) MCP stdio.

### Known Limitations (MVP)
- 6 of 15 planned MCP tools implemented
- No UI changes yet (V1 React UI unchanged)
- No plugin system yet
- `ingest_traces` V1 stub not completed
- LSP coverage for 147/158 languages still missing
