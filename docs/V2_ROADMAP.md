# V2 Roadmap — Codebase Memory V2

> Updated 2026-07-05 for version 0.9.1.

## Current State (0.9.1)

### ✅ Completed

| Feature | Version | Details |
|---|---|---|
| Human Memory DB | 0.1.0 | 11 node labels, 12 edge types, SQLite WAL, transactions |
| Obsidian vault sync | 0.1.0 | Bidirectional, HUMAN NOTES preserved, backup rotation |
| Code graph bridge | 0.1.0 | Read-only access to V1 SQLite, bulk fetch, column aliases |
| 7 MCP tools | 0.1.0-0.4.0 | get_project_overview, get_module_context, get_undocumented_hotspots, create_human_note, link_note_to_code_node, search_code_and_memory, prepare_edit_context |
| CLI (15+ commands) | 0.1.0-0.3.0 | init, doctor, mcp, ui, stats, demo, backup, obsidian, human, report |
| Intelligence layer | 0.4.0 | Graph freshness detection, smart recommendations, prepare_edit_context |
| Project identity | 0.3.0 | LICENSE, CONTRIBUTING, CI/CD, Dockerfile, README EN |
| Export idempotency | 0.4.2 | Sync doesn't re-write unchanged files |
| Token economy | 0.4.3 | Compact responses, no duplication, pre-computed metrics |
| Graph UI V2 | 0.5.0 | 2D d3-force canvas, dashboard, HTTP server, 4 tabs |
| UI precision fixes | 0.5.1 | 45 bugs fixed, 11 blockers resolved (GraphCanvas TDZ, edge rendering, @ alias) |
| Round 12 deep precision | 0.5.2 | 23 bugs (3 CRITICAL UI compilation, 8 HIGH, 5 MEDIUM, 7 LOW) |
| N+1 query elimination | 0.5.3 | getBulkNotesByCbmNodeIds, getBulkNodeDegrees — /api/layout 2000→4 queries |
| Round 14 deep audit | 0.5.4 | 18 bugs (5 CRITICAL sync/data, 7 HIGH, 4 MEDIUM, 2 LOW). markSynced hash consistency, safeJsonParse array validation, UI server double-response crash |
| Round 15 N+1 + UX | 0.5.5 | 16 bugs (3 CRITICAL, 6 HIGH, 5 MEDIUM, 2 LOW). getBulkNotesByCbmNodeIds SQL-level ROW_NUMBER(), getBulkEdges(), backup N+1 fix, ProjectCard redesign |
| Full docs audit | 0.5.5 | 6 docs updated (README, ROADMAP, MCP_TOOLS, CLI_REF, TOKEN_ECONOMY, ARCHITECTURE) |
| 7 new API endpoints | 0.6.0 | /api/adr (GET+POST), /api/browse, /api/index, /api/index-status, /api/processes, /api/process-kill, /api/project-delete, /api/logs |
| ControlTab full implementation | 0.6.0 | Processes list, logs viewer, index jobs, kill process |
| Round 18 God function refactor | 0.6.1 | generateVault (235→30 LOC) + importVault (200→15 LOC) split into focused sub-functions |
| Round 19 bug fixes | 0.6.2 | createEdge cbm_node_ids sync (CRITICAL), --force flag honored (HIGH) |
| Round 20 storage optimization | 0.6.3 | Migration V2: drop useless index, composite indexes, PRAGMA temp_store + cache_size. maxNodes DoS fix |
| Round 21 junction table | 0.7.0 | Migration V3: human_node_cbm_links junction table replacing JSON_EACH. Indexed reverse lookup, FK CASCADE, WITHOUT ROWID |
| Round 22 docs + bug fixes | 0.7.1 | 6 docs updated, human link validation, obsolete comment, junction table consistency |
| Round 23 bug fixes | 0.7.2 | pruneBackups cross-file deletion (basename fix), parseJsonBody 30s timeout, backup version |
| Round 24 UI bugs | 0.7.3 | ControlTab setState-on-unmounted, NodeDetailPanel dead Show code button, useProjects stale responses |
| Round 25 WebSocket real-time | 0.8.0 | Bidirectional push notifications, NotifyHub debounce 200ms, auto-reconnect (backoff), keepalive ping/pong |
| Round 26 Claude Sonnet 5 report | 0.8.1 | 6 bugs: CRITICAL frontmatter revert (import before export), HIGH create_human_note atomicity, HIGH no-op frontmatter, MEDIUM Vite WS proxy, LOW vaultHash vestigial, LOW MCP shutdown DB close |
| Round 27 Bug #8 rename | 0.8.1 | Stale edges on rename: resolveExistingNode match by slug even if obsidian_path exists (checks old file deleted), no-op check compares obsidian_path, processWikilinks cleans old source_file |
| Round 28 docs sync | 0.8.2 | 6 docs updated, audit of 5 potential bugs (none required fixes) |
| Round 29 watch daemon | 0.9.1 | `cbm-v2 watch` daemon with fs.watch recursive, debounce 500ms, NotifyHub integration, incremental import+export |

### 📊 Metrics

| Metric | Value |
|---|---|
| Source files (v2) | 36 |
| Test files | 25 |
| Tests | 247 (all passing) |
| Bugs fixed (29 rounds) | 485+ |
| MCP tools | 7 |
| CLI commands | 16+ (including `watch` daemon) |
| API endpoints | 15 (6 existing + 9 new) |
| Graph UI components | 13 |
| SQLite migrations | 3 (initial_schema, optimize_indexes, cbm_links_junction_table) |
| CI pipeline stages | 3 (typecheck → build → test) |
| Production dependencies | 4 (better-sqlite3, commander, yaml, ws) |

## Roadmap

### Phase 1: Stability & Developer Experience (0.6.x-0.9.x)

| Feature | Priority | Complexity | Status |
|---|---|---|---|
| ✅ 7 missing API endpoints | Done | Medium | Completed in 0.6.0 |
| ✅ ControlTab full implementation | Done | Medium | Completed in 0.6.0 |
| ✅ Refactor God functions | Done | Medium | Completed in 0.6.1 |
| ✅ Storage optimization (indexes + PRAGMAs) | Done | Medium | Completed in 0.6.3 |
| ✅ Junction table (complex storage) | Done | High | Completed in 0.7.0 |
| ✅ WebSocket real-time | Done | High | Completed in 0.8.0 |
| ✅ `cbm-v2 watch` daemon | Done | Medium | Completed in 0.9.1 |
| Tests for reports (hotspots, undocumented, risk) | High | Medium | Planned |
| ESLint + Prettier configuration | Medium | Low | Planned |
| `noUncheckedIndexedAccess` in tsconfig | Medium | Low | Planned |
| Compact MCP responses (shorter excerpts) | Medium | Low | Planned |
| UI tests (vitest + testing-library) | Medium | Medium | Planned |

### Phase 2: Proactive Intelligence (0.8.0)

| Feature | Priority | Complexity | Status |
|---|---|---|---|
| Git hooks (post-commit → auto-journal) | High | Medium | Planned |
| `smart-sync` incremental (mtime-based) | High | Medium | Planned |
| Proactive suggestions (undocumented modules) | Medium | Medium | Planned |
| Conflict detection (read sync_state) | Medium | Medium | Planned |
| MCP tool timeout (30s) | Medium | Low | Planned |
| Human memory overlay on graph | Medium | High | Planned |
| `cbm-v2 watch` daemon (auto-sync) | Medium | Medium | Planned |

### Phase 3: V1 Complete (0.9.1)

| Feature | Priority | Complexity | Status |
|---|---|---|---|
| 9 remaining MCP tools | Medium | High | Planned |
| Plugin system (C ABI) | Low | Very High | Planned |
| `human_metrics` cache table | Low | Low | Planned |

### Phase 4: Scale (1.0.0)

| Feature | Priority | Complexity | Status |
|---|---|---|---|
| Streaming MCP (NDJSON) | Medium | High | Planned |
| Multi-user / remote store | Low | Very High | Planned |
| LSP coverage (147/158 remaining) | Low | Very High | Planned |
| `ingest_traces` V1 stub completion | Low | Medium | Planned |

## Audit History

| Round | Version | Bugs Found | Bugs Fixed | Tests |
|---|---|---|---|---|
| MVP | 0.1.0 | — | — | 10 |
| R1 | 0.2.0 | 77 | 77 | 114 |
| R2 | 0.2.1 | 85 | 85 | 114 |
| R3 (Kimi) | 0.2.2 | 9 | 9 | 124 |
| R4 | 0.2.3 | 78 | 78 | 124 |
| Identity | 0.3.0 | — | — | 124 |
| R5 | 0.3.1 | 10 | 10 | 124 |
| R6 (invisible) | 0.3.2 | 20 | 20 | 139 |
| R7 (final) | 0.3.3 | 19 | 19 | 139 |
| R8 (excellence) | 0.3.4 | 17 | 17 | 139 |
| Intelligence | 0.4.0 | — | — | 139 |
| R9 (precision) | 0.4.1 | 10 | 10 | 153 |
| R10 (clean) | 0.4.2 | 15 | 15 | 156 |
| R11 (deep) | 0.4.3 | 11 | 11 | 156 |
| Graph UI V2 | 0.5.0 | — | — | 156 |
| R11-ui-precision | 0.5.1 | 45 | 45 | 156 |
| R12 (deep precision) | 0.5.2 | 23 | 23 | 156 |
| R13 (N+1 elimination) | 0.5.3 | 15 | 15 | 156 |
| R14 (deep audit) | 0.5.4 | 18 | 18 | 170 |
| R15 (N+1 + UX) | 0.5.5 | 16 | 16 | 175 |
| R16 (docs audit) | 0.5.5 | — (docs) | — | 175 |
| R17 (7 API endpoints) | 0.6.0 | — (features) | — | 194 |
| R18 (God function refactor) | 0.6.1 | — (refactor) | — | 194 |
| R19 (bug fixes) | 0.6.2 | 2 | 2 | 200 |
| R20 (storage optimization) | 0.6.3 | 1 (DoS) | 1 | 207 |
| R21 (junction table) | 0.7.0 | — (feature) | — | 221 |
| R22 (docs + bug fixes) | 0.7.1 | 3 | 3 | 223 |
| R23 (bug fixes) | 0.7.2 | 3 | 3 | 227 |
| R24 (UI bugs) | 0.7.3 | 3 | 3 | 227 |
| R25 (WebSocket real-time) | 0.8.0 | — (feature) | — | 239 |
| R26 (Claude Sonnet 5 report) | 0.8.1 | 6 | 6 | 239 |
| R27 (Bug #8 rename) | 0.8.1 | 1 | 1 | 241 |
| R28 (docs sync) | 0.8.2 | — (docs) | — | 241 |
| R29 (watch daemon) | 0.9.1 | — (feature) | — | 247 |
| **Total** | | **485+** | **485+** | **247** |

## Performance Milestones

| Round | Path | Before | After | Reduction |
|---|---|---|---|---|
| R13 | `/api/layout` notesCount | 2000 queries | 4 queries | -99.8% |
| R13 | `/api/dashboard` critical notes | 5000 queries | 1 query | -99.98% |
| R13 | `prepare_edit_context` | ~100 queries | ~4 queries | -96% |
| R13 | `report undocumented` | ~25000 queries | ~25 queries | -99.9% |
| R14 | `/api/layout` edges | ~2000 queries | ~4 queries | -99.8% |
| R14 | `prepare_edit_context` blast radius | 3 getNodesByIds | 1 | -67% |
| R14 | GraphCanvas listener rebinds | 4 per filter toggle | 0 | -100% |
| R15 | `get_project_overview` | ~5000 queries | ~4 queries | -99.9% |
| R15 | `backup export` edges | ~1000 queries | 1 query | -99.9% |
| R15 | `getBulkNotesByCbmNodeIds` (limit=1, 10000 notes) | 10000 rows | 1 row | -99.99% |
| R20 | SQLite index bloat | 6 indexes (1 useless) | 5 indexes (all used) | -17% write overhead |
| R20 | SQLite temp_store | disk I/O for sorting | MEMORY | -90% sort latency |
| R21 | `getBulkNotesByCbmNodeIds` (5000 modules) | ~2.5M JSON_EACH ops | ~5000 B-tree lookups | -80% to -95% |

## API Endpoints (0.9.1)

| Endpoint | Method | Description |
|---|---|---|
| `/api/layout` | GET | Graph layout data (nodes + edges, bulk-fetched) |
| `/api/projects` | GET | List indexed projects with node/edge counts + health |
| `/api/project-health` | GET | Check DB integrity for a specific project |
| `/api/project-delete` | POST | Delete a project's code graph + human DB (R17) |
| `/api/dashboard` | GET | Dashboard data (KPIs, freshness, recommendations) |
| `/api/human-notes` | GET | Human notes for a code node |
| `/api/graph-status` | GET | Graph freshness status |
| `/api/adr` | GET | List all ADR notes (R17) |
| `/api/adr` | POST | Create or update an ADR note (R17) |
| `/api/browse` | GET | File picker — list directories (R17) |
| `/api/index` | POST | Trigger a V1 index job (async) (R17) |
| `/api/index-status` | GET | List index jobs (R17) |
| `/api/processes` | GET | List running cbm/node processes (R17) |
| `/api/process-kill` | POST | Kill a process by PID (R17) |
| `/api/logs` | GET | Recent log lines (R17) |

## SQLite Schema Migrations

| Version | Name | Description |
|---|---|---|
| 1 | `initial_schema` | Base tables: human_nodes, human_edges, human_metrics, sync_state |
| 2 | `optimize_indexes` | Drop useless idx_cbm_node_ids, replace single-column with composite (project, label/status) indexes |
| 3 | `cbm_links_junction_table` | Create human_node_cbm_links junction table (WITHOUT ROWID, PK, FK CASCADE) + backfill from cbm_node_ids JSON |
