# Changelog — Codebase Memory V2

## 0.10.6 — Round 42 (2026-07-06)

4 issues fixed based on Claude Sonnet round 5 audit (1 LOW a11y, 1 LOW doc arithmetic, 1 LOW doc stale, 1 MEDIUM perf). 10 new tests (339 total).

### Fixes (Claude Sonnet round 5 audit)

- **App.tsx D1** (LOW a11y): `aria-labelledby={`tab-${activeTab}`}` on the `<main>` tabpanel referenced an `id` that didn't exist — no tab `<button>` had `id={`tab-${tab.id}`}`. The `aria-controls` (button→panel) relationship was wired correctly, but the reverse (panel→button) was broken, so screen readers couldn't resolve the accessible name from the label relationship. Fixed: added `id={`tab-${tab.id}`}` to each tab button.

- **CHANGELOG.md D2** (LOW doc): the R41 entry's parenthetical breakdown summed to 15 ("2 MEDIUM perf" + "8 LOW") while the header said 13 and the actual bullet count was 12 (L2+N2 is one bullet covering 2 issues). Recounted: 1 HIGH perf + 1 HIGH complexity + 1 MEDIUM perf + 1 MEDIUM UX + 2 MEDIUM leak + 7 LOW = 13. Corrected the parenthetical to match the header.

- **CLI_REFERENCE.md D3** (LOW doc): the `cbm-v2 watch` section described the export mechanism but didn't mention the `source: 'watch-import'` tag filtering (R40) that prevents redundant exports. Given the guard went through 3 redesigns (boolean → timestamp window → source tagging), the current mechanism is worth documenting precisely. Added a paragraph explaining the source-tag filter and the known-harmless no-op from store-emitted events.

- **searchHumanNodes E1** (MEDIUM perf): FTS5 search was phrase-only — the entire query was wrapped in one pair of double quotes, requiring words to appear as an exact adjacent phrase. Changed to AND-of-terms: each whitespace-separated term is individually quoted and joined with spaces, so FTS5 treats them as an implicit AND. A search for "auth login bug" now matches notes containing all three words anywhere (reordered, scattered across title/body/tags), not just notes with the literal three-word phrase. Single-term queries degenerate to the same phrase query as before. The LIKE fallback is unchanged (uses the original full substring).

### Test coverage
- 10 new tests in `tests/round42-fixes.test.ts`: AND-of-terms matching (all terms required, missing-term exclusion, reordered equivalence, scattered terms, extra whitespace, limit, deprecated exclusion, LIKE fallback).

## 0.10.5 — Round 41 (2026-07-06)

13 issues fixed across V2 + Graph UI (1 HIGH perf, 1 HIGH complexity, 1 MEDIUM perf, 1 MEDIUM UX, 2 MEDIUM leak, 7 LOW). 23 new tests (329 total).

### HIGH fixes

- **search_code_and_memory M5**: replaced 5× `LIKE %q%` substring scan (10k rows × 5 comparisons = 50k ops) with FTS5 full-text search. New migration V4 adds `human_nodes_fts` virtual table (external-content, porter+unicode61 tokenizer) + 3 sync triggers. New `searchHumanNodes()` method on HumanMemoryStore uses `MATCH` + `ORDER BY rank` (BM25 scoring), falls back to LIKE if FTS5 table is missing or query syntax errors. Ranking is now relevance-based instead of `updated_at DESC` — semantically better.
- **server.ts L1**: refactored `handleApi` from a 588-line monolith with 17 chained `if (path === ...)` blocks into a 22-line route-table dispatcher (`Map<string, RouteHandler>`). Each route is now a private method (`routeLayout`, `routeProjects`, etc.). Adding a route no longer requires editing the central method.

### MEDIUM fixes

- **report.ts N1**: `HumanMemoryStore` handle leaked when `CodeGraphReader` constructor threw — the early `return` jumped over the second `try/finally`. Fixed: extracted `withProjectStores()` helper wraps open-compute-close in a single `try/finally` that always closes both handles. Applied to all 3 report actions (hotspots, undocumented, risk).
- **server.ts L2+N2**: `/api/projects` ran 2 separate `countNodes` + `countEdges` queries per project (2N queries for N projects) and skipped `reader.close()` on exception (handle leak on Windows). Fixed: new `countAll(project)` method does both counts in 1 query (subquery pattern), and `reader.close()` moved to a `finally` block.
- **GraphCanvas UI-9**: no pan bounds + no reset-view control — user could drag the graph entirely off-screen with no recovery except page refresh. Fixed: pan clamped to ±10× viewport, `GraphCanvas` now exposes `resetView()`/`zoomBy()` via `forwardRef`/`useImperativeHandle`, "Reset view" button added to GraphTab actions.

### LOW fixes

- **store.ts L4**: slug-collision loop re-prepared the SELECT statement per attempt (up to 100×). Hoisted the `prepare()` call above the loop.
- **server.ts L3**: 4 redundant `await import('node:fs'/'node:child_process')` calls (one was pure dead code shadowing the static import; 3 were dynamic imports on every request). Replaced with static top-level imports.
- **human.ts N3**: `human create` action had a redundant outer try/catch wrapping an inner try/catch with identical handler — the outer catch was unreachable (inner catch's `return` always fired first). Collapsed into a single try.
- **Sidebar.tsx UI-7**: `flattenSingleChild` was O(n²) on deep single-child directory chains (`src/a/b/c/d/e/file.ts`) — the inner `flattenSingleChild(sc)` re-flattened an already-flattened subtree. Fixed: use `sc.children` directly.
- **GraphTab/FilterPanel UI-8**: "Show labels" toggle was dead code — FilterPanel rendered the checkbox but `GraphCanvas.draw` never rendered any text. Removed the toggle + state + props.
- **importer.ts L6**: `resolveExistingNode` returned `HumanNode | null | 'CONFLICT'` (string-literal discriminator that defeated TypeScript's exhaustiveness checking). Refactored to throw a typed `SlugConflictError` class, caught via `instanceof` at the call site.
- **GraphCanvas/App UI-10**: `<canvas>` had no `role`/`aria-label`; tab buttons lacked `role="tab"`/`aria-selected`/`aria-controls`. Added ARIA tablist semantics + canvas role="img" with descriptive label.

### Test coverage
- 23 new tests in `tests/round41-fixes.test.ts`: FTS5 migration presence + triggers, searchHumanNodes by title/body/tag, deprecated exclusion, project scoping, FTS5 sync after create/update/delete, countAll correctness + scoping, SlugConflictError class behavior, slug-collision behavioral parity.
- Updated `tests/round20-optimizations.test.ts` for the new migration count (3 → 4).

## 0.10.4 — Round 40 Deep Quality (2026-07-06)

12 issues fixed across V2 + Graph UI (5 HIGH bugs, 4 MEDIUM perf, 1 MEDIUM latent bug, 2 LOW UX). 14 new tests (306 total).

### HIGH fixes (correctness)
- **watch.ts** guard window silently dropped MCP/API-triggered exports within 1500ms of a sync (H1). Fixed: filter by `event.data.source === 'watch-import'` in the hub subscriber instead of the timestamp guard. Legitimate MCP mutations now propagate to the vault regardless of when the last file-triggered sync completed.
- **useWebSocket** zombie-connection race on project change (UI-1). The old socket's `onclose` fired after the new socket was already open, scheduling a reconnect to the OLD project and leaking project-A events into project-B's view. Fixed: generation counter invalidates stale callbacks.
- **GraphCanvas** stale highlights when simulation idle (UI-3). Effect-ordering bug — the redraw effect ran BEFORE the drawRef sync, so the canvas was painted with the OLD draw closure. Fixed: merge the redraw into the drawRef sync so the new draw is always called after being installed.
- **GraphCanvas** simulation recreated on every filter toggle (UI-2). Toggling a single checkbox tore down the entire d3-force sim and rebuilt it with `.alpha(1)` — every node lost its position and the graph "exploded". Fixed: reuse the sim across data changes, preserve x/y/vx/vy for existing nodes, reheat gently with `.alpha(0.3)`.
- **GraphCanvas** node-drag left the simulation running forever if `mouseup` fired off-canvas (UI-5). Fixed: bind `mouseup` to `window` for the duration of the drag so it fires regardless of where the cursor is when the button is released.

### MEDIUM fixes (performance — N+1 elimination)
- **create_human_note** validated each link target with a separate `getNodeById` query (M2). Fixed: batch-verify all `cbm_node_ids` in a single `getNodesByIds` call. Reports ALL missing ids in one error message instead of short-circuiting on the first. For a note linking 10 symbols: 1 query instead of 10.
- **prepare_edit_context** called `getNeighbors` per matching node — 20 nodes × 2 queries = 40 queries (M3). Fixed: new `getBulkNeighbors` method on `CodeGraphReader` fetches all neighbors in 3 queries (2 for edges + 1 for neighbor nodes). Same return shape, ~13× fewer queries.
- **generator.ts** called `getNodesByIds` per human node during vault sync — 500 nodes × 1 query = 500 queries per page (M4). Fixed: bulk-fetch all `cbm_node_ids` for the page in ONE call, pass the map down through `syncSingleNode → renderNoteForVault → renderAutoGeneratedSection`.
- **wikilinks.ts** `inferEdgeTypeFromContext` recomputed the fence state per wikilink — O(K×N) for K wikilinks and N lines (M8). Fixed: extract `buildFenceState(lines)` + `inferEdgeTypeFromContextWithState(lines, fenceState)` and call them once per note in the importer. ~K× speedup for notes with multiple wikilinks.

### MEDIUM fix (latent bug)
- **swr-cache** refresh handler ignored the caller's custom `ttlMs`/`staleMs` opts (L5). After the first background refresh, the entry silently degraded to the cache's default TTL. Fixed: store `opts` alongside the handler and use them in `scheduleBackgroundRefresh`.

### LOW fixes (UX)
- **ResizeHandle** missing `onPointerCancel` left the drag stuck if the OS interrupted the pointer (e.g., touch gesture). Fixed: bind `onPointerCancel` to the same handler as `onPointerUp`.
- **NodeTooltip** overflowed the viewport when hovering nodes near the right/bottom edges. Fixed: measure the tooltip and flip the offset when near the edge.

### Test coverage
- 14 new tests in `tests/round40-fixes.test.ts` covering buildFenceState, getBulkNeighbors, swr-cache opts preservation, and the H1 source-filter behavior.

## 0.10.3 — Round 39 (2026-07-06)

Extended `countNodesByLabel` (R38 GROUP BY optimization) to `get_project_overview` and `generateVault`. Single-query count for dashboard + module/route auto-generation.

## 0.10.2 — Round 38 (2026-07-05)

CI flaky test fix + `countNodesByLabel` optimization (-80% queries on `/api/dashboard`).

## 0.10.1 — Round 37 SWR Cache (2026-07-05)

Stale-While-Revalidate cache for `getGraphStatus` — adaptive TTL (3×/10× access thresholds), memory-aware eviction, background refresh dedup. Stale reads return in 0ms with background refresh.

## 0.10.0 — Round 36 (2026-07-05)

TTL cache for `getGraphStatus`, batch transaction for `importVault` (500+ → 1 transaction), generator `walkVaultIter` (yields one at a time instead of building a full array).

## 0.9.6 — Round 35 (2026-07-04)

NotifyHub flush preserves data; backup version sync.

## 0.9.0 — Round 29 Watch Daemon (2026-07-04)

`cbm-v2 watch` daemon — fs.watch recursive, debounce 500ms, timestamp guard for double-export suppression. NotifyHub attaches to HumanMemoryStore for in-process MCP notifications.

## 0.8.0 — WebSocket Real-Time UI (2026-07-03)

15 API endpoints (6 original + 9 R17 additions). React + d3-force 2D graph UI with 4 tabs (Dashboard, Graph, Stats, Control). WebSocket with reconnection (1s→15s backoff) and ping/pong keepalive.

## 0.7.0 — Junction Table (2026-07-02)

`human_node_cbm_links` junction table replaces JSON_EACH on `cbm_node_ids`. Migration V3. `WITHOUT ROWID`, covering index `idx_cbm_links_cbm_id`. `getBulkNotesByCbmNodeIds` now does B-tree lookups instead of JSON_EACH scans (-80% to -95% on 5000-module projects).

## 0.5.0 — Round 20 Schema Migration V2 (2026-07-01)

Dropped 4 unused indexes (`idx_human_nodes_project`, `idx_human_nodes_label`, `idx_human_nodes_status`, `idx_human_nodes_cbm_node_ids` — the JSON-text index was useless since JSON_EACH cannot use it). Added composite indexes `idx_human_nodes_project_label` and `idx_human_nodes_project_status`.

## 0.4.3 — Round 10 Deep Precision (2026-07-04)

11 bugs fixed (4 HIGH, 4 MEDIUM, 3 LOW). Token economy improvements.

### HIGH fixes
- `prepare_edit_context` risk/blast-radius underestimated (capped at 50 neighbors). Fixed: use uncapped `getNodeDegree()`.
- `get_undocumented_hotspots` duplicates (critical Modules in both module and critical arrays). Fixed: exclude Module/Route from critical array.
- Importer created edges from AUTO-GENERATED wikilinks (duplicating existing DECIDES edges with MENTIONS). Fixed: parse wikilinks only from HUMAN NOTES.
- `get_module_context` include_adrs/bugs/refactors ignored when include_human=false. Fixed: moved outside the guard.

### Token economy
- `human_notes` no longer includes ADRs/bugs/refactors (they have their own arrays). Saves ~500 chars × N notes.
- `prepare_edit_context` now reports `nodes_found` so agent knows if 20-node limit was hit.

## 0.4.2 — Clean Audit (2026-07-04)

15 bugs fixed (1 CRITICAL, 5 HIGH, 6 MEDIUM, 3 LOW). Export idempotency fix.

### CRITICAL fix
- Export was NOT idempotent — every sync re-wrote every file forever. "Last sync" timestamp in body + regex leaving empty line gap. Fixed: removed body timestamp, fixed regex to consume newline.

## 0.4.1 — Precision Fixes (2026-07-04)

10 bugs in intelligence code fixed. 14 new tests (graph-status).

## 0.4.0 — Intelligence Layer (2026-07-04)

Major release: V2 is now PROACTIVE and GRAPH-AWARE.

### New features
- `prepare_edit_context` MCP tool (flagship) — context before editing
- Graph freshness detection (stale detection via git log + DB mtime)
- Enhanced `get_project_overview` with graph_status + smart recommendations
- 7 MCP tools (was 6)

## 0.3.0-0.3.4 — Project Identity + Rounds 5-8

- LICENSE, CONTRIBUTING.md, .gitlab-ci.yml, Dockerfile
- `cbm-v2 demo`, `cbm-v2 stats`, `cbm-v2 backup export/import`
- README rewritten in English
- 4 audit rounds (R5-R8), 121 bugs fixed
- Constants centralization (16/16)
- Export idempotency regression test

## 0.2.0-0.2.3 — Audit Rounds 1-4

- 249 bugs fixed across 4 rounds
- 114 → 139 tests
- Constants centralization started
- `safeJsonParse` helper
- `process.exit` → `process.exitCode` refactor
- Transaction wrap for `createNode` (TOCTOU fix)
- Path traversal protection
- MCP protocol compliance (batch, ping, -32600/-32601/-32602, id:null vs undefined)

## 0.1.0 — MVP (2026-07-04)

Initial release. Human memory graph + Obsidian sync + 6 MCP tools + CLI. 10 tests.
