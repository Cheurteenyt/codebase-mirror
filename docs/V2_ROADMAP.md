# V2 Roadmap — Codebase Memory V2

> **Historical roadmap, archived at 0.15.9.** For all rounds after this
> archived roadmap, see `v2/CHANGELOG.md`.

## Current State (0.15.9 — archived)

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
| Round 29 watch daemon | 0.9.0 | `cbm-v2 watch` daemon with fs.watch recursive, debounce 500ms, NotifyHub integration, incremental import+export |
| Round 30 watch hardening | 0.9.1 | Watch daemon try/catch error handling, dead code removal, French to English in docs |
| Round 31 Claude Sonnet 5 R2 | 0.9.2 | 8 fixes: B1 double-export guard, B2 rename, B3 auto-generate flags, C1 HiDPI DPR, C2 stale filter, D1 v2/README tool count, D2 version, D3 bug count |
| Round 32 Claude Sonnet 5 R3 | 0.9.3 | 5 fixes: C-new-1 CRITICAL guard timing (timestamp), B-new-1 zoom HiDPI, B-new-2 filter reset, D-new-1 version, D-new-2 bug count |
| Round 33 regression tests | 0.9.4 | 11 regression tests for R32 fixes: filter persistence, timestamp guard, zoom-to-cursor math |
| Round 34 UI server shutdown fix | 0.9.5 | UI server EADDRINUSE handler now closes DB handles before process.exit (same class as R26 Bug #6) |
| Round 35 NotifyHub flush + backup version | 0.9.6 | NotifyHub flush() preserves data payload via PendingEvent struct; backup export version updated to 0.9.6 |
| Round 36 architecture perf | 0.10.0 | TTL cache (30s) for getGraphStatus, batch transaction in importer (10-100x faster), generator-based walkVaultIter for memory efficiency |
| Round 37 SWR cache | 0.10.1 | Stale-While-Revalidate cache with adaptive TTL, memory-aware eviction, background refresh — replaces TtlCache for getGraphStatus |
| Round 38 CI fix + countNodesByLabel | 0.10.2 | Fixed flaky SWR test (isolated cache instance), added countNodesByLabel (5 queries -> 1 GROUP BY for /api/dashboard) |
| Round 39 countNodesByLabel expansion | 0.10.3 | Applied countNodesByLabel to get_project_overview MCP tool (4->1 query) and generateVault 00_Index.md (4->1 query) |
| Round 40 deep quality | 0.10.4 | 12 fixes: H1 watch guard (source filter), UI-1 WS zombie race (gen counter), UI-2 sim reuse on filter, UI-3 stale highlight effect order, UI-4 hover setState dedup, UI-5 mouseup window, UI-11 pointer cancel, UI-12 tooltip viewport flip, M2 create_human_note batch validate, M3 getBulkNeighbors (40->3 queries), M4 generator page-level bulk code nodes, M8 buildFenceState (O(K×N) -> O(N+K)), L5 swr-cache opts preserved across refreshes. 14 new tests (306 total) |
| Round 41 FTS5 + route table | 0.10.5 | 13 fixes: M5 FTS5 search (migration V4, searchHumanNodes, BM25 ranking), L1 handleApi route-table refactor (588->22 lines), N1 report.ts resource leak (withProjectStores helper), L2+N2 countAll single-query + finally close, UI-9 pan bounds + reset view (forwardRef), L4 slug prepare hoist, L3 dead dynamic imports, N3 dead outer catch, UI-7 sidebar O(n²) fix, UI-8 dead showLabels toggle, L6 SlugConflictError class, UI-10 ARIA tablist + canvas role. 23 new tests (329 total) |
| Round 42 Claude Sonnet R5 audit | 0.10.6 | 4 fixes from external audit: D1 tab button id (aria-labelledby contract), D2 changelog arithmetic correction, D3 watch docs (source-tag guard mechanism), E1 FTS5 AND-of-terms search (phrase-only → multi-term AND, matches scattered/reordered words). 10 new tests (339 total) |
| Round 43 proactive audit (security + C1 regression) | 0.10.7 | 14 fixes: C1 CRITICAL useGraphData loading gate unmounted GraphCanvas on WS refetch (defeated R40 sim reuse — now project-aware stale-while-revalidate), SEC1 /api/index project_name argument-injection validation, SEC2 /api/process-kill allowlist cbm/node PIDs, SEC3 /api/browse restricted to home dir, H1 DashboardTab same loading gate fix, M1 NodeDetailPanel risk-score display, M2 ErrorBoundary key={project}, M3 ControlTab kill confirmation, M5 StatsTab error retry button, L1 NodeDetailPanel ~80 lines dead code removed (Show code + GitHub link + rpc.ts deleted), L2 groupByType O(n²)→O(n) + memoized, a11y close buttons aria-label. 4 new tests (343 total) |
| Round 44 Claude Sonnet R7 audit (security gaps + frontend tests) | 0.10.8 | 5 fixes: B1 /api/index leading-hyphen rejection + `--` separator (closes bare-flag argument injection that passed R43's regex), B2 /api/process-kill narrowed allowlist from `cbm|node` substring to `cbm|cbm-v2` whole-word + tracked job PIDs (was matching every Node.js process), B3 /api/browse realpathSync before containment check (closes symlink bypass), Part C frontend test infrastructure (vitest config + setup + first 3 tests), C1 regression test (useGraphData same-project refetch preserves data). 5 new tests (348 total: 345 backend + 3 frontend) |
| Round 45 client timeout + test coverage expansion | 0.10.9 | 8 fixes: F1 api/client.ts AbortController 20s timeout + exported ApiError (was hanging forever on locked SQLite), F6 /api/project-health path-traversal validation (SEC4 — same regex as routeIndex/routeProjectDelete), F2 useDashboard C1 regression test (3 tests, mirrors useGraphData), F3 useWebSocket generation-counter test (2 tests, mocks WebSocket), F5 GraphCanvas sim-reuse test (2 tests, mocks d3-force + canvas), F4 useProjects AbortController (was running to completion after unmount), F7 /api/processes regex aligned with kill regex, F8 /api/project-delete omits db_path (info-leak). 9 new tests (357 total: 347 backend + 10 frontend) |
| Round 46 transaction atomicity + component test coverage | 0.11.0 | 8 fixes: F7 updateNode/deleteNode/createEdge transaction wrapping (was leaving JSON cache + junction table out of sync on crash), F8 get_undocumented_hotspots label enum validation (was silently returning empty for invalid labels), F1 NodeTooltip viewport-flip test (3 tests), F2 ResizeHandle pointerCancel test (1 test), F3 Sidebar flattenSingleChild test (2 tests), F4 ControlTab kill-confirmation test (2 tests), F5 StatsTab retry test (1 test), F6 ProjectCard corrupt-state test (2 tests). 11 new frontend tests (368 total: 347 backend + 21 frontend) |
| Round 47 performance + invisible bugs | 0.11.1 | 10 fixes: H1 prepare_edit_context under-reported linked notes (limit=1 default, was hiding bugs/ADRs from agents), H2 generator N+1 getNeighbors for modules+routes (200+ queries → 6 via getBulkNeighbors), H3 routeDashboard 3 redundant queries (reuse SWR-cached graphStatus), M1 ControlTab AbortController (was piling up requests on slow backend), M3 hotspots report notes_count under-reported (limit=1 → 200), M4 parseNote --- in quoted YAML (defensive check prevents note corruption), L1 swr-cache refresh timer cancellation on invalidate, L2 syncCbmLinks DELETE inside transaction (self-contained atomic), L3 ControlTab kill timer cleanup. 6 new tests (374 total: 353 backend + 21 frontend) |
| Round 48 CI fix + invisible bugs | 0.11.2 | 6 fixes: #1 CRITICAL GitLab CI mirror force-pushed ANY branch to GitHub main (clobbered main on feature branch pushes), #2 HIGH ControlTab interval aborted stale controller (request pileup + stale data), #3 MEDIUM parseNote regex replaced with line-by-line scanner (--- in quoted YAML no longer corrupts notes), #4 MEDIUM parseNote test strengthened (was passing despite data loss), #5 LOW swr-cache set() cancels pending refresh timers, #6 LOW ControlTab kill timer clears previous timer. |
| Round 49 deep audit + perf | 0.11.3 | 9 fixes: cherry-pick of R48 (which had been missed by the working branch), H1 importer skip-wikilinks-for-unchanged (~10× speedup), H2 swr-cache stale-hit scheduling guard, M1 generator bulk-neighbor fetch, M2 hotspots report notes_count under-reported, M3 ControlTab AbortController, L1 swr-cache evictToFit clears refreshHandlers, L2 syncCbmLinks DELETE inside transaction, L3 dead else-if branch removed. |
| Round 50 deep audit (cache invalidation + perf revert) | 0.11.4 | 9 fixes: #1 HIGH invalidateGraphStatusCache was never called after re-index (SWR cache served stale total_nodes/total_edges for up to 60s), #2 MEDIUM perf revert of R49 #8 routeLayout SWR reuse (getGraphStatus on cold cache adds 50-200ms), #3 MEDIUM doc CONTRIBUTING.md + Dockerfile GitLab URLs updated to GitHub, 6 LOW cleanup/doc. |
| Round 51 security audit | 0.12.0 | 8 security fixes (1 CRITICAL, 3 HIGH, 2 MEDIUM, 2 LOW): SEC-5 CRITICAL vault.ts symlink traversal (realpathSync + lstatSync), SEC-6/7/8/10/13 IDOR + path traversal + stale PID reuse, SEC-15 unbounded YAML alias count. |
| Round 52 CI quality + security hardening | 0.12.1 | 6 CI fixes: permissions: contents: read (least-privilege), removed pretest doubling the build, npm install --no-audit --no-fund, quota-report single API call, BusyBox date fix, simplified quota-report output. |
| Round 53 Claude Sonnet R8 audit | 0.12.1 | 8 fixes: D1 HIGH mirror --force-with-lease (prevents silent PR loss), D2 MEDIUM token via http.extraHeader (no token in URL), B1 CHANGELOG R47-R49 backfill, B2 CHANGELOG R51-R52 + version bump, B3 CONTRIBUTING.md GitLab label fix, Part C shared safeRealpath utility, Part E GraphTab C1 chain test. |
| Round 54 CI pipeline fix | 0.12.1 | 3 CI fixes: R54 workflow:rules + mr-preflight job (MR pipelines were empty → "Pipelines must succeed" blocked MRs), R54b YAML block scalars (YAML parsed `: ` as mapping not string), R54c ls-remote + --force-with-lease=main:<sha> (--force-with-lease without explicit SHA fails on URL push). |
| Round 55 Claude Sonnet R9 audit | 0.12.2 | 4 fixes: Part A HIGH safe-path.ts dead code wired up (vault.ts assertPathInsideVault → assertPathInsideRoot, server.ts routeBrowse → safeRealpath, routeIndex → safeRealpathStrict), D3 HIGH quota-report job-level permissions: actions: read override (workflow-level contents: read was silently 403ing /actions/runs API), D4 LOW removed unreachable v2/** push pattern, D5 LOW quota-report restricted to schedule-only. |
| Round 56 self-audit + MAINTAINERS_GUIDE | 0.12.3 | 3 improvements: symlink escape test for assertPathInsideRoot (2 new tests — vault.test.ts now covers the actual SEC-5 attack vector, not just symlink loops), backup.ts version field clarified (10-line comment block — was ambiguous between schema version and package version), MAINTAINERS_GUIDE.md new file (workflow conventions, naming rules, required patterns, anti-patterns, CI/CD setup, audit etiquette — accumulated across 77 rounds). |
| Round 57 doc cleanup + private notes | 0.12.4 | Doc consistency + maintainability (no code changes). 12 stale refs fixed across v2/README.md (test count 374→378, version refs 0.11.3→0.12.4, security section R51/R55), CONTRIBUTING.md (6→7 tools, 374→378 tests, 5→9 docs, npm ci→npm install, stale "planned: 0.4.0" removed, CI/CD section rewritten), MAINTAINERS_GUIDE.md (376→378 tests, R55→R56). MAINTAINERS_GUIDE.md enriched with Common pitfalls (9 items), Pre-commit checklist (12 items), Lessons learned (6 items). MAINTAINERS_NOTES.local.md created (gitignored) — operational reminders, env reset recovery, gotchas. |
| Round 58 code quality + type safety + perf | 0.12.5 | No bugs fixed — code quality + type safety + perf in store.ts. 6 row type interfaces added (HumanNodeRow, HumanEdgeRow, IdRow, CountRow, LabelCountRow, HumanNodeWithCbmIdRow). 18 `as any` casts replaced with proper row types. deserializeNode/Edge typed properly. safeJsonParseArray: any[]→unknown[]. params: any[]→(string|number)[]. 3 hot-path prepared statements moved to constructor (getNodeById, getNodeBySlug, getNodeByObsidianPath). |
| Round 59 code quality + type safety in sqlite-ro.ts | 0.12.6 | No bugs fixed — same pattern as R58 applied to code graph reader. 11 row type interfaces added (CodeNodeRow, NeighborRow, DegreeCountRow, CountRow, CountAllRow, LabelCountRow, TypeCountRow, EdgeTripleRow, BulkEdgeRow, ProjectNameRow, ProjectRow). 30 `as any` casts replaced. deserializeCodeNode/makeEdge/tryPush typed properly. Null safety: NeighborRow.node_properties coalesced with ?? '{}'. 2 hot-path prepared statements moved to constructor (getNodeById, findNodeByQualifiedName). |
| Round 60 code quality in swr-cache.ts | 0.12.7 | No bugs fixed — dead code + duplication + fragility in SWR cache. effectiveMaxEntries dead ternary removed (both branches identical). evictOne() extracted from evictToFit() (pattern was duplicated 2×). invalidatePrefix() now collects keys before iterating (defensive — avoids modifying Map during iteration). catch (e: any)→catch (e: unknown) in background refresh. on() method typed with SwrCacheRefreshEvent<K> interface (was ...args: any[]). |
| Round 61 code quality in server.ts | 0.12.8 | No bugs fixed — type safety in UI server. 7 `catch (e: any)` → `catch (e: unknown)` with new `UiServer.errorMessage(e: unknown)` static helper (replaces `e.message` access on `any`-typed value — would throw if `e` was not an Error). 2 `(ws as any)._projectFilter` removed → `WeakMap<WebSocket, string | undefined>` (type-safe, auto-GC, no field-name typos). |
| Round 62 code quality in importer.ts + generator.ts | 0.12.9 | No bugs fixed — type safety + deduplication in Obsidian sync engine. importer.ts: duplicated import loop extracted into `importAllFiles` helper (was verbatim in both dry-run and transaction branches). 2 `catch (e: any)` → `catch (e: unknown)`. `existingBySlug` explicitly typed `HumanNode | null` (was inferred as `null` only). generator.ts: 2 `catch (e: any)` → `catch (e: unknown)`. |
| Round 63 server.ts architecture refactor | 0.13.0 | **Minor version bump** — server.ts split from 1212 lines into 7 files. New structure: `server.ts` (290 lines, thin coordinator), `types.ts` (RouteContext, RouteHandler, IndexJob), `helpers.ts` (sendJson, errorMessage, parseJsonBody, MIME_TYPES), `routes/graph.ts` (layout, dashboard, graphStatus), `routes/project.ts` (projects, projectHealth, projectDelete), `routes/human.ts` (humanNotes, adrGet, adrPost), `routes/index.ts` (index, indexStatus), `routes/system.ts` (browse, processes, processKill, logs). Key abstraction: `RouteContext` — routes receive dependencies explicitly instead of accessing `this.*`. No functional changes, 378 tests pass. |
| Round 64 deep audit — bug fix + 36 catch(any) removed | 0.13.1 | Deep audit: 1 bug fixed (routeIndex status race — spawn ENOENT returned 202 instead of 500). 36 `catch (e: any)` → `catch (e: unknown)` across 17 v2 files (MCP tools, CLI commands, config.ts) + graph-ui/api/client.ts (2). schema.ts `r: any` → typed. All `e.message` → `e instanceof Error ? e.message : String(e)`. Remaining `any` is justified (openMemory private field access, deepMerge generic, JSON-RPC protocol types, test mocks). |
| Round 65 V1 C engine audit (reference) | 0.13.2 | Deep audit of V1 C engine (65,620 LOC). V1 kept intact. Findings documented in docs/V1_AUDIT_R65.md: 1 HIGH (strcat overflow), 2 MEDIUM (unchecked malloc, slab_owns O(n)), 1 LOW (slab_realloc ordering). V1 strengths: arena+slab+interning+mimalloc, atomic worker pool, SQLite PRAGMAs, Verstable hash table, back-pressure. V2 eliminates V1's buffer/malloc bugs by design (TypeScript bounds-safe, V8 GC). |
| Round 66 performance benchmark suite | 0.13.3 | Created v2/scripts/benchmark.ts (19 benchmarks). All pass "excellent". SWR cache: 0.0003ms (3.4M ops/sec). Prepared stmts (R58): 0.002-0.006ms (178K-453K ops/sec). Bulk queries (R40): 88x speedup vs N+1. Write path: 0.11ms (9K ops/sec). No operation exceeds 2ms — V2 is not a bottleneck. Full report: docs/PERFORMANCE_BENCHMARK_R66.md. |
| Round 67 V1+V2 combined benchmark | 0.13.4 | Built V1 from source (562 files, 259MB binary). Indexed V2 codebase: 35 files → 460 nodes, 1499 edges in 305ms (115 files/sec). V2 queries same DB: 0.006ms getNodeById, 0.077ms searchCode. V1 vs V2: SQLite overhead negligible (+0.005ms JS binding). V2 SWR cache faster for repeated queries. Key gap: V2 depends entirely on V1 for code analysis — no fallback when cbm binary unavailable. Full report: docs/V1_V2_BENCHMARK_R67.md. |
| Round 68 native TypeScript/JavaScript indexer | 0.14.0 | **Minor version bump** — V2 can now index TS/JS projects without V1 `cbm` binary. New module `v2/src/indexer/` (schema.ts + extractor.ts + indexer.ts) using ts-morph. Extracts nodes (File, Class, Function, Method, Variable) + edges (CONTAINS, IMPORTS, CALLS). Schema-compatible with V1 (sqlite-ro.ts reads transparently). New CLI: `cbm-v2 index`. Benchmark: V2 native 1833ms vs V1 305ms (6x slower but works without cbm binary). Limitations: TS/JS only, no similarity/cross-repo/git-history/traces. |
| Round 69 web-tree-sitter WASM — 112 languages | 0.15.0 | **Minor version bump** — V2 indexer upgraded from ts-morph (1 language) to web-tree-sitter WASM (112 languages). 5.4x speedup (340ms vs 1833ms), 2.2x more nodes (784 vs 352). Within 12% of V1 C speed (340ms vs 305ms) with NO binary dependency. Supports TS/TSX/JS/Python/Go/Rust/Java/C/C++/Ruby/PHP/Swift/Kotlin/Scala/Dart/Lua/Bash/YAML/JSON/HTML/CSS/SQL/Dockerfile/Markdown + 88 more. New deps: web-tree-sitter + tree-sitter-wasm. Multi-language benchmarks: V2/src 340ms, V1/C 1233ms (122 files), graph-ui 243ms. |
| Round 69b package.json fix | 0.15.1 | Fix: R69 commit lost original package.json deps (npm install overwrote instead of merged). Restored better-sqlite3, commander, ws, yaml, typescript, vitest, @types/* + kept new web-tree-sitter, tree-sitter-wasm, ts-morph, tsx. CI was failing. |
| Round 70 Claude Sonnet R10 audit | 0.15.2 | 3 fixes from Claude Sonnet 5 R10. Part A: vault.ts path safety (capture assertPathInsideRoot return value). Part B: WASM anonymous@line disambiguation. Part C: benchmark node count caveat. |
| Round 71 worker_threads parallel indexing | 0.15.3 | New v2/src/indexer/worker.ts — parallel WASM parsing. Files grouped by language, split into batches, distributed to worker_threads. Two-pass edge resolution. Auto-detects workers (min 2). Parallel mode for 100+ files. 122 C files: 1262ms with 2 workers. On 8+ cores: expected 4-6x speedup. Limitation: cross-file CALLS limited in parallel. |
| Round 72 fast-walker: descendantsOfType optimization | 0.15.4 | **1.3x speedup** — replaced recursive JS AST walking with tree-sitter's built-in `descendantsOfType()` WASM method. New `v2/src/indexer/fast-walker.ts`. v2/src: 379→288ms (1.32x). v1/src: 1302→1013ms (1.29x). graph-ui: 230→211ms (1.09x). Eliminated ~500 JS function calls/file. Dead code removed from wasm-extractor.ts. |
| Round 73 fast-walker micro-optimizations | 0.15.5 | 4 micro-opts: removed descendantCount (unused WASM traversal), removed rootNode.text.length (O(n) copy), pre-built JSON strings (no JSON.stringify per node), Map-based parent resolution (O(1) vs O(n) linear search). v2/src: 288→277ms. V2 is now **9% faster than V1 C** (277ms vs 305ms). |
| Round 74 two-phase extraction architecture | 0.15.6 | Restructured single-thread indexer into Phase 1 (extract all, no SQLite) + Phase 2 (write all, one transaction). Better cache locality, shorter transaction duration. Skipped tree.delete() (WASM GC handles cleanup). Performance within noise of R73. Architectural consistency with parallel path. |
| Round 75 pre-read + skip setLanguage + batch INSERT | 0.15.7 | 3 opts: pre-read all files before parsing (OS prefetch), skip redundant parser.setLanguage when same language (49/50 calls eliminated), multi-row batch INSERT (50 rows/statement vs single-row). v2/src: 282→273ms. V2 is now **10% faster than V1 C** (273ms vs 305ms). |
| Round 76 single-pass complexity + skip anonymous | 0.15.8 | 2 opts: single descendantsOfType call for complexity (was 2), skip complexity estimation for anonymous functions (complexity=1). v2/src: 273→267ms (1.07x). v1/src parallel: 995→897ms (1.11x). V2 is now **12% faster than V1 C** (267ms vs 305ms). |
| Round 77 honest benchmark reassessment | 0.15.9 | **Corrects R72-R76 measurement error.** Rigorous 5-iteration wall-clock benchmark reveals V2 is actually **11% SLOWER** than V1 (401ms vs 361ms) due to Node.js startup + WASM init overhead (~110ms). V2's extraction phase alone IS 20% faster (267ms vs 335ms). V1 also extracts 2.2x more edges (1681 vs 768) due to LSP call resolution. Full report: docs/RIGOROUS_BENCHMARK_R77.md. |

### 📊 Metrics

| Metric | Value |
|---|---|
| Source files (v2) | 38 |
| Test files | 43 (32 backend + 11 frontend) |
| Tests | 378 (355 backend + 23 frontend, all passing) |
| Bugs fixed (77 rounds) | 565+ |
| MCP tools | 7 |
| CLI commands | 16+ (including `watch` daemon) |
| API endpoints | 15 (6 existing + 9 new) |
| Graph UI components | 13 |
| SQLite migrations | 4 (initial_schema, optimize_indexes, cbm_links_junction_table, human_nodes_fts) |
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
| ✅ `cbm-v2 watch` daemon | Done | Medium | Completed in 0.10.3 |
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

### Phase 3: V1 Complete (0.15.9)

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
| R29 (watch daemon) | 0.9.0 | — (feature) | — | 247 |
| R30 (watch hardening) | 0.9.1 | 0 (cleanup) | 0 | 247 |
| R31 (Claude Sonnet 5 R2) | 0.9.2 | 5 | 5 | 247 |
| R32 (Claude Sonnet 5 R3) | 0.9.3 | 5 | 5 | 247 |
| R33 (regression tests) | 0.9.4 | — (tests) | — | 258 |
| R34 (UI server shutdown) | 0.9.5 | 1 | 1 | 258 |
| R35 (NotifyHub flush + backup version) | 0.9.6 | 2 | 2 | 258 |
| R36 (architecture perf) | 0.10.0 | — (perf) | — | 272 |
| R37 (SWR cache) | 0.10.1 | — (perf) | — | 292 |
| R38 (CI fix + countNodesByLabel) | 0.10.2 | 1 (flaky test) | 1 | 292 |
| R39 (countNodesByLabel expansion) | 0.10.3 | — (perf) | — | 292 |
| R40 (deep quality: 5 HIGH bugs + 4 N+1 + 1 latent + 2 UX) | 0.10.4 | 12 | 14 | 306 |
| R41 (FTS5 + route table + leaks + a11y) | 0.10.5 | 13 | 23 | 329 |
| R42 (Claude Sonnet R5 audit) | 0.10.6 | 4 | 10 | 339 |
| R43 (proactive: C1 regression + 3 security + 10 UX/cleanup) | 0.10.7 | 14 | 4 | 343 |
| R44 (Claude Sonnet R7: security gaps + frontend tests) | 0.10.8 | 5 | 5 | 348 |
| R45 (client timeout + test coverage expansion) | 0.10.9 | 8 | 9 | 357 |
| R46 (transaction atomicity + component test coverage) | 0.11.0 | 8 | 11 | 368 |
| R47 (performance + invisible bugs) | 0.11.1 | 10 | 6 | 374 |
| R48 (CI fix + invisible bugs) | 0.11.2 | 6 | 0 | 374 |
| R49 (deep audit + perf) | 0.11.3 | 9 | 0 | 374 |
| R50 (deep audit: cache invalidation + perf revert) | 0.11.4 | 9 | 0 | 374 |
| R51 (security audit: 1 CRITICAL + 7 fixes) | 0.12.0 | 8 | 0 | 374 |
| R52 (CI quality + security hardening) | 0.12.1 | 6 | 0 | 374 |
| R53 (Claude Sonnet R8 audit: D1/D2/B1-B3/Part C/Part E) | 0.12.1 | 8 | 2 | 376 |
| R54 (CI pipeline fix: workflow:rules + block scalars + lease SHA) | 0.12.1 | 3 | 0 | 376 |
| R55 (Claude Sonnet R9 audit: Part A + D3 + D4 + D5) | 0.12.2 | 4 | 0 | 376 |
| R56 (self-audit + MAINTAINERS_GUIDE: symlink escape test, backup version clarify, MAINTAINERS_GUIDE.md) | 0.12.3 | 0 | 2 | 378 |
| R57 (doc cleanup: 12 stale refs fixed, MAINTAINERS_GUIDE pitfalls+checklist+lessons, private notes) | 0.12.4 | 0 | 0 | 378 |
| R58 (code quality: 18 as any→row types, 3 hot-path prepared statements, deserialize typed) | 0.12.5 | 0 | 0 | 378 |
| R59 (code quality: 30 as any→row types in sqlite-ro.ts, 2 hot-path prepared statements) | 0.12.6 | 0 | 0 | 378 |
| R60 (code quality: dead ternary removed, evictOne extracted, defensive iteration, typed events) | 0.12.7 | 0 | 0 | 378 |
| R61 (code quality: 7 catch(any)→catch(unknown), 2 ws as any→WeakMap, errorMessage helper) | 0.12.8 | 0 | 0 | 378 |
| R62 (code quality: importer dedup importAllFiles, 4 catch(any)→catch(unknown), existingBySlug typed) | 0.12.9 | 0 | 0 | 378 |
| R63 (architecture: server.ts 1212→290 lines, split into 7 files, RouteContext abstraction) | 0.13.0 | 0 | 0 | 378 |
| R64 (deep audit: 1 bug fixed routeIndex 202→500, 36 catch(any)→catch(unknown), schema r:any typed) | 0.13.1 | 1 | 0 | 378 |
| R65 (V1 C engine audit: 65K LOC, 1 HIGH strcat, 2 MEDIUM malloc/slab, docs/V1_AUDIT_R65.md) | 0.13.2 | 0 | 0 | 378 |
| R66 (benchmark suite: 19 benchmarks, all excellent, SWR 0.0003ms, prepared 0.006ms, docs/PERFORMANCE_BENCHMARK_R66.md) | 0.13.3 | 0 | 0 | 378 |
| R67 (V1+V2 combined benchmark: V1 index 305ms, V2 query 0.006ms, key gap identified, docs/V1_V2_BENCHMARK_R67.md) | 0.13.4 | 0 | 0 | 378 |
| R68 (native TS/JS indexer: ts-morph, 48 files→352 nodes→1070 edges, 1833ms, no cbm binary needed) | 0.14.0 | 0 | 0 | 378 |
| R69 (WASM tree-sitter: 112 languages, 340ms, 784 nodes, 5.4x faster than R68, 12% of V1 speed) | 0.15.0 | 0 | 0 | 378 |
| R69b (package.json fix: restore original deps lost during npm install) | 0.15.1 | 0 | 0 | 378 |
| R70 (Claude R10: vault.ts path safety, WASM anonymous@line, benchmark caveat) | 0.15.2 | 3 | 0 | 378 |
| R71 (worker_threads parallel: worker.ts, 2 workers, 100+ file threshold, 2-pass edge resolution) | 0.15.3 | 0 | 0 | 378 |
| R72 (fast-walker: descendantsOfType, 1.3x speedup, 288ms v2/src, 1013ms v1/src) | 0.15.4 | 0 | 0 | 378 |
| R73 (micro-opts: no descendantCount, no text.length, pre-built JSON, Map O(1) parent, 277ms v2/src) | 0.15.5 | 0 | 0 | 378 |
| R74 (two-phase extract-then-write, skip tree.delete, shorter transaction, architectural consistency) | 0.15.6 | 0 | 0 | 378 |
| R75 (pre-read files, skip setLanguage, multi-row batch INSERT 50 rows/statement, 273ms v2/src) | 0.15.7 | 0 | 0 | 378 |
| R76 (single-pass complexity estimation, skip anonymous, 267ms v2/src, 897ms v1/src) | 0.15.8 | 0 | 0 | 378 |
| R77 (honest benchmark: V2 11% slower in wall time, 20% faster in extraction only, docs corrected) | 0.15.9 | 0 | 0 | 378 |
| R78–R107 | 0.16.0–0.42.0 | — | — | — |
| **Total** | | **566+** | **513+** | **378** |

> **Note:** Rounds R78–R107 (versions 0.16.0–0.42.0) are documented in
> `v2/CHANGELOG.md`. Key milestones: R78 rigorous benchmark fix, R79-R85
> incremental mode + mtime_ns precision, R86-R94 parallel + failure safety,
> R98-R101 cross-file CALLS resolution, R102-R105 stale flag + deletion
> cleanup, R106 persistent call_sites table + deletion-only fast path,
> R107 call_sites_initialized flag (fixes legacy DB ambiguity).
> The V2 indexer now has 60 tests across 12 test files covering correctness,
> incremental safety, cross-file CALLS, stale flag semantics, call_sites
> persistence, and deletion cleanup.

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
| R36 | `getGraphStatus` (repeated calls) | execSync('git log') every call (50-200ms) | TTL cache hit (0ms) | -100% within 30s window |
| R36 | `importVault` (500 files) | 500+ individual transactions | 1 batch transaction | -90% to -99% WAL overhead |
| R36 | `walkVault` (1000 files) | Array of 1000 strings in memory | Generator yields one at a time | -90% peak memory |
| R37 | `getGraphStatus` (stale reads) | 50-200ms blocking on every TTL expiry | 0ms stale return + background refresh | -100% latency on stale reads |
| R38 | `/api/dashboard` countNodes | 5 separate COUNT queries | 1 GROUP BY query | -80% query count |
| R39 | `get_project_overview` countNodes | 4 separate COUNT queries | 1 GROUP BY query | -75% query count |
| R39 | `generateVault` 00_Index.md countNodes | 4 separate COUNT queries | 1 GROUP BY query | -75% query count |
| R40 | `prepare_edit_context` neighbors | 20 nodes × 2 = 40 separate getNeighbors queries | 3 queries via getBulkNeighbors | -92% query count |
| R40 | `generateVault` renderAutoGeneratedSection | 500 separate getNodesByIds (1 per note) | 1 bulk getNodesByIds per page | -99.8% query count |
| R40 | `create_human_note` link validation | N× getNodeById (1 per link) | 1 getNodesByIds for all links | -(N-1)/N queries |
| R40 | `importVault` wikilink edge inference | O(K×N) fence state rebuild per wikilink | O(N+K) buildFenceState once + per-wikilink slice | -~K× wall time |
| R41 | `search_code_and_memory` human search | 5× LIKE %q% substring scan (10k rows × 5 ops) | FTS5 MATCH with BM25 ranking (inverted index) | -95%+ on large vaults |
| R41 | `/api/projects` per-project counts | 2N queries (countNodes + countEdges) × N projects | N queries (countAll single-query) | -50% query count |
| R41 | `server.ts handleApi` | 588-line monolith with 17 chained ifs | 22-line route-table dispatcher | -96% method size |
| R41 | `Sidebar flattenSingleChild` | O(n²) on deep single-child chains | O(n) (use already-flattened sc.children) | -~n× on deep chains |
| R42 | `searchHumanNodes` FTS5 query | Phrase-only (entire query in one pair of quotes — required exact adjacent phrase) | AND-of-terms (each term individually quoted, implicit AND) | Matches scattered/reordered words, not just adjacent phrases |

## API Endpoints (0.15.9)

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
