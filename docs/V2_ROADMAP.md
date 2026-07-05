# V2 Roadmap — Codebase Memory V2

> Updated 2026-07-05 for version 0.5.5.

## Current State (0.5.5)

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

### 📊 Metrics

| Metric | Value |
|---|---|
| Source files (v2) | 32 |
| Test files | 16 |
| Tests | 175 (all passing) |
| Bugs fixed (15 rounds) | 403+ |
| MCP tools | 7 |
| CLI commands | 15+ |
| Graph UI components | 12 |
| CI pipeline stages | 3 (typecheck → build → test) |
| Production dependencies | 3 |

## Roadmap

### Phase 1: Stability & Developer Experience (0.6.0)

| Feature | Priority | Complexity | Status |
|---|---|---|---|
| `cbm-v2 watch` daemon | High | Medium | Planned |
| Refactor `generateVault` (230 LOC → sub-functions) | High | Medium | Planned |
| Refactor `importVault` (188 LOC → sub-functions) | High | Medium | Planned |
| Tests for reports (hotspots, undocumented, risk) | High | Medium | Planned |
| ESLint + Prettier configuration | Medium | Low | Planned |
| `noUncheckedIndexedAccess` in tsconfig | Medium | Low | Planned |
| Compact MCP responses (shorter excerpts) | Medium | Low | Planned |
| 7 missing API endpoints (ADR, browse, index, processes, logs) | Medium | Medium | Planned |
| UI tests (vitest + testing-library) | Medium | Medium | Planned |

### Phase 2: Proactive Intelligence (0.7.0)

| Feature | Priority | Complexity | Status |
|---|---|---|---|
| Git hooks (post-commit → auto-journal) | High | Medium | Planned |
| `smart-sync` incremental (mtime-based) | High | Medium | Planned |
| Proactive suggestions (undocumented modules) | Medium | Medium | Planned |
| Conflict detection (read sync_state) | Medium | Medium | Planned |
| MCP tool timeout (30s) | Medium | Low | Planned |
| Human memory overlay on graph | Medium | High | Planned |
| `cbm-v2 watch` daemon (auto-sync) | Medium | Medium | Planned |

### Phase 3: V1 Complete (0.8.0)

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
| **Total** | | **403+** | **403+** | **175** |

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
