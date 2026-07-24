# Changelog — Codebase Memory V2

## 0.78.0-alpha.1 — bounded exact source lookup (2026-07-20)

### R184 competitive truth correction

- Preregistered, executed, reconciled, and sealed a four-arm Ariad versus
  optimized source, Graphify, and Graphify plus Obsidian comparison across a
  controlled fixture, p-limit, zod, and FastAPI. The current report publishes
  wins, ties, losses, invalid cells, graph-caused evidence, and unsupported
  conclusions separately.
- Replaced Windows-hostile NodeNext import matching with portable path and
  extension resolution. File-to-File `IMPORTS` edges are now exact,
  deduplicated, directed, and evidence-bearing; extractor semantics advances
  from 8 to 9 so incompatible databases force a full reindex.
- Added bounded exact directory context to `get_module_context`, including
  exact membership/internal-edge totals, incoming/outgoing dependency groups,
  linked human memory, and explicit truncation.
- Promoted exact directories in Graph UI search and reused the existing scope
  HUD to show the strongest external dependency with outgoing/incoming totals.
  No renderer, permanent panel, production dependency, or bundle-budget
  exception was added.
- The measured result is deliberately mixed: Ariad wins index/update time and
  exact failure visibility, but Graphify remains lighter on small indexing,
  renders sooner, and Graphify plus Obsidian leads the minimum-edit-context
  task. Every arm fails the human-rationale task, and neither UI passes the
  strict visual task family.

### MCP precision and token economy

- Extended `lookup_source_text` without adding a ninth MCP tool: the default
  `literal_matches` contract remains compatible, while `direct_callers`
  aggregates persistent call sites and `top_level_directories` returns exact
  Git-tracked inventory. Both profiles use deterministic bounded output and
  explicit completeness, ambiguity, staleness, fallback, and truncation
  metadata.
- Direct-caller aggregation preserves repeated call sites, rolls nested
  anonymous callbacks up to the nearest named owner, and excludes tests by
  default. Tracked inventory uses `git ls-files` through an argument array,
  normalizes Windows and POSIX paths, includes hidden directories, and fails
  honestly to an incomplete indexed fallback when Git is unavailable.
- Removed unconditional overview-first and prepare-before-edit guidance.
  Exact literals and inventory now route to exact profiles; graph context is
  recommended only when the requested evidence requires it.
- Added regressions for deterministic grouping, bounds, duplicate symbols,
  legacy and stale metadata, Git fallback, path normalization, unchanged
  literal requests, read-only annotations, and stable eight-tool discovery.
- Added the bounded `call_chain` profile for exact HTTP-route and CLI-command
  traces. It builds one production call-site map, rolls anonymous callbacks
  into named owners, recovers omitted multiline calls from bounded definition
  text, prunes duplicate symbol names through reverse reachability, and returns
  a deterministic shortest chain with explicit alternatives, caps, freshness,
  ambiguity, and completeness metadata.
- `call_chain` also accepts a semantic `target_hint` when the task does not
  reveal the exact terminal name. Lexical resolution is restricted to symbols
  in the bounded production call-site map, returns scores and alternatives,
  and fails completeness closed on a tie. The ready-to-copy `formatted_chain`
  prevents label and path reformatting errors.
- Added the read-only `lookup_source_text` MCP tool for batched,
  case-sensitive literal lookup with exact 1-based path, line, column, and
  declaration text. It fills the source-evidence gap without changing any of
  the seven existing tool names or contracts.
- Confined reads to distinct graph-owned paths under the published project
  root, with canonical symlink containment and explicit incomplete-scan
  reasons. Calls are bounded to 10 literals, 20,000 indexed paths, 4 MiB per
  file, 128 MiB total, and 50 returned occurrences per literal.
- Added focused regressions for batched CRLF line accounting, independent
  result truncation, traversal and symlink escape refusal, invalid batches,
  MCP discovery, and the read-only tool annotations.
- Audited the benchmark T07/T08 mismatch against a fresh index of the exact
  target commit. `nodes` and `call_sites` contain the correct 1-based lines;
  the observed wrong answers came from missing source-occurrence evidence in
  the existing payloads, not an indexer off-by-one.
- Repeated the pre-registered 12-task benchmark with only the exact lookup
  added to the MCP condition. MCP improved from 7 PASS / 2 PARTIAL / 3 FAIL to
  12 PASS, reduced total tokens from 5,326,294 to 1,372,780 (74.2%), and cut
  calls from 421 to 106 (74.8%). This is not presented as a baseline win:
  contemporaneous grep/read still used only 563,870 tokens and 23 calls.

### Documentation architecture

- Reorganized active documentation into `reference`, `architecture`,
  `operations`, and `performance`, with superseded audits, benchmarks,
  roadmaps, round reports, and release history isolated under `docs/history`.
- Replaced the round-by-round `V2_CURRENT_STATE.md` ledger with a concise
  current product snapshot that names executable sources of truth and the
  measured token, platform, Graph UI, and inactive-publication boundaries.
- Added one canonical documentation portal, a Graph UI contributor entry
  point, consistent status/audience/verification metadata, and an indexed
  historical archive.
- Added the cross-platform `npm run docs:check` gate for local links, anchors,
  metadata, root classification, and portal reachability, with focused parser
  regressions and Linux/Windows CI coverage.
- Reduced the packaged changelog to the current release window while
  preserving releases 0.75.0 through 0.12.0 in a linked historical archive.
- Preserved the current publication boundary in the active window: R169B is
  merged at `15a732d91984e5b4ffa29b4e129ac0d6316c9fca`, but its primitives remain
  **MERGED / INACTIVE**. The product still uses the legacy `<project>.db`
  through `defaultCodeDbPath`; R169C is future integration work.

## 0.77.0-alpha.1 — structured and exact Graph UI (2026-07-16)

### Graph fidelity and navigation

- Replaced the flat overview with a deterministic domain → community → node
  map, progressive edge bundles, bounded local physics, stable drill-down, and
  explicit representative-versus-exact fidelity metadata.
- Added exact, project-scoped, keyset-paginated node search and neighborhood
  APIs so search and detail views are not limited to the overview sample.
- Bound layout, search, neighborhood, and exact cursors to an opaque SQLite
  snapshot revision. A changed graph fails closed with an explicit HTTP 409,
  and the UI discards stale pages before restarting from page one.
- Added exact top-level domain coverage, root-file scope parity, global symbol
  search, exact detail pagination, refresh-safe off-overview selection, and
  honest partial/error states.
- Added roving ARIA tree navigation, bounded keyboard navigation for the
  canvas, focus restoration, reduced-motion support, a non-tabbable closed
  mobile drawer, a single selected tree item, and consistent
  keyboard/pointer/touch interactions.
- Kept transient exact-neighborhood failures visible and retryable; only a
  current HTTP 404 can invalidate an off-overview selection.

### Single-renderer task views

- Added an optional, locally persisted `Stellar flow` task view beside the
  default `Architecture` map. Both use the same bounded graph, canvas, d3
  simulation object, selection, filters, keyboard model, and exact detail
  contracts.
- Restored the useful V1 degree-at-a-glance spectral scale using exact V2
  in/out degree, while preserving node type without color dependence through
  circle, diamond, and square glyphs. Status continues to use an outer stroke.
- Added a deterministic exact-degree hub orbit. Selecting a symbol unfolds up
  to four visible incoming/outgoing layers, keeps unrelated symbols as dim
  outer context, and renders bounded direction chevrons only for the selected
  flow.
- Added the bounded Stellar Flow Lens: numbered hop rails, repeated directory
  lane labels, semantic multi-hop relation strokes, a selection-only DOM
  legend, and outward three-anchor label placement. Color is no longer the
  only relation channel because calls/imports/contains/data/other use distinct
  dash patterns and text glyphs.
- Pin the active Stellar focus to the semantic origin and release the previous
  focus on selection or mode changes. This prevents high-fan-out link forces
  from pulling the selected node into an outgoing lane while retaining the
  same simulation and node objects.
- A view/focus change reconfigures and reheats the existing simulation exactly
  once. Known filter subsets remain settled; no Three.js/WebGL dependency,
  shadow filter, per-node gradient, second renderer, canvas, or node-object
  graph is introduced.
- Added regressions for deterministic flow targets, incoming/outgoing depth,
  spectral/glyph semantics, persistence, canvas identity, bounded reheating,
  and the existing Graph chunk gzip budget.
- Removed the redundant selected-scope action from the top toolbar after a
  1,280 px runtime check exposed a HUD overlap. Selection clearing remains in
  the side panel and the always-visible `Architecture` breadcrumb. The action
  bar now waits until `xl` for a horizontal layout, or `2xl` while the detail
  panel narrows the canvas, with both states covered by DOM regressions.
- Move the selected Stellar guide above the breadcrumb and show only relation
  groups that actually touch the focus, avoiding both HUD overlap and a global
  legend that would consume attention without answering the active task.
- Added the responsive Stellar Focus Composer. It fits directed targets—not
  dim project context—inside screen-space safe bounds reserved for graph chrome,
  recomposes after untouched panel/viewport resizes without reheating d3, and
  gives distant depths monotonic compressed spacing so the first hop remains
  readable beside the detail panel.
- Rank flow-label candidates on semantic-frame changes instead of every Canvas
  paint. The focus label budget now follows usable viewport area, exact/direct
  neighbors lead, unrelated context labels stay out of the selected frame, and
  any label that would be clipped or hidden by persistent controls is omitted.

### Performance and delivery gates

- Filtered induced edges inside SQLite, retained layout/simulation objects
  across compatible refreshes, limited device-pixel allocation, and kept
  overview transfer and rendering explicitly bounded.
- Intersected highlights with the rendered topology, recomputed selected
  neighborhoods after filters, prioritized architecture scopes at aggregate
  zoom levels, and enforced strict semantic label budgets.
- Added Brotli/gzip response compression, ETags, a bounded compressed-payload
  cache, a reproducible Graph UI runtime benchmark, and enforced gzip bundle
  budgets for the entry, Graph chunk, CSS, and total JavaScript.
- Extended the installed-tarball CI smoke to index a real TypeScript fixture
  and verify packaged JS/CSS assets, layout, exact domain catalog, search,
  neighborhood, and shared graph revision while preserving the required-check
  display name.

## 0.76.0 — performance, precision, UI, and update readiness (2026-07-15)

### Performance and token efficiency

- Restored complete discovery as the default while retaining an explicit
  `--discovery-mode fast` full-rebuild mode; discovery policy version 3
  prevents silent cache reuse across the corrected coverage boundary. Fast
  discovery is rejected with incremental indexing before any database access,
  preventing omitted source families from being deleted or certified stale.
- Compact every MCP JSON result without changing its parsed schema. The new
  `bench:tokens` command compares the actual compact payload with a pretty
  serialization reconstructed locally from the same parsed value; it measures
  JSON whitespace transport bytes, not tokenizer output.
- Added behavioral annotations to all seven MCP tools, bounded high-volume
  numeric inputs, portable module/file resolution, explicit ambiguity errors,
  and honest match/analysis truncation metadata.
- `prepare_edit_context` now computes callers, callees, degree, risk, and blast
  radius from `CALLS` edges only instead of inflating them with structural
  `CONTAINS` and `IMPORTS` edges.
- Graph overview sampling is deterministic and balanced by label and degree,
  reserves capacity for dead-code candidates, and returns exact sampling and
  truncation metadata. The UI requests at most 1,000 overview nodes.

### Graph UI quality and runtime behavior

- Lazy-load the Graph and Control routes, pause dashboard/graph WebSocket work
  while hidden, and revalidate when a warm tab becomes visible again.
- Preserve graph simulation objects and settled positions by node ID, avoid
  reheating identical/subset data, and fit/reset against the real graph bounds.
- Size collision and hit-testing consistently, keep the canvas mounted through
  empty filters, expose shown/total sampling state, and improve responsive
  navigation, project cards, dashboards, statistics, focus, and ARIA panels.
- Stack graph actions below the HUD on narrow screens to prevent the deterministic
  390px overlap found during the final independent review.

### Update and distribution readiness

- Require Node.js 22.12.0 or newer, test the exact floor on Linux and Windows,
  and use Node 24 LTS for development and Docker. Both packages declare
  `packageManager: npm@10.9.0` as an authoring/Corepack hint, not a runtime
  constraint; npm 10 and npm 11 are compatible with the v3 lockfiles.
- Re-enabled bounded grouped Dependabot minor/patch updates for GitHub Actions,
  V2, Graph UI, and Docker. Applied the safe in-range dependency patches while
  leaving breaking majors as deliberate migrations.
- The package and Docker CI jobs now launch the embedded UI over HTTP from the
  final artifact, including an arbitrary working directory for the npm package.
- Added an explicit Graph UI typecheck script and a reliable cross-platform V1/V2
  benchmark harness that fails closed on incomplete runs.

### Final lifecycle hardening

- Terminate complete owned indexer process trees (POSIX process groups and
  Windows `taskkill /T /F`) and wait for their cleanup within the shutdown budget.
- Bound HTTP/WebSocket shutdown globally, escalate non-cooperative peers, and
  close project-health readers in `finally` on every error path.

### CONF-R169-001, 002 and 008 — project-store correctness

- Route each UI request through a bounded per-project store registry instead
  of reusing the startup project's physical SQLite handles.
- Open code and human handles lazily, require both physical partitions before
  treating logical names as aliases, revalidate aliases after path replacement,
  and block deletion while a request lease is in flight.
- Refresh the code reader atomically after a successful first index and only
  announce completion after the resulting graph can be opened.
- Refuse project deletion by canonical path/file identity, including
  case-insensitive aliases of an open store.

### CONF-R169-003 and 005 — owned index process lifecycle

- Removed the arbitrary-PID `/api/process-kill` mutation. Index jobs retain
  their own `ChildProcess` handle and expose only
  `/api/index-jobs/<jobId>/terminate`.
- Ignore unused stdout, retain only a bounded stderr tail, limit concurrent and
  duplicate jobs, enforce a timeout, and terminate/kill owned children during
  asynchronous server shutdown.
- Finalize from the direct child's `exit` event if a descendant keeps a pipe
  open, and prevent a partially received index POST from spawning after server
  shutdown has begun.
- Launch the packaged/source V2 indexer directly instead of assuming the
  legacy `cbm` executable is installed.

### CONF-R169-004 — localhost HTTP and WebSocket boundary

- Added exact Host and Origin validation, JSON-only mutations, a runtime
  256-bit CSRF/WebSocket credential, Sec-Fetch-Site checks, WebSocket payload
  and message-rate limits, and browser hardening headers.
- The frontend now bootstraps and retries runtime credentials, including a
  forced refresh when reconnecting after a server restart.

### CONF-R169-006 — exact-SHA post-merge governance

- Made the merge gate non-cancellable once running and added an idempotent,
  repository-owned watchdog that checks and dispatches missing CI/CodeQL runs
  only for the current exact `main` SHA.

### Cross-platform update verification

- Replaced POSIX-only environment assignment in both smoke benchmark npm
  scripts with the portable `--smoke` option while preserving the old
  environment switch for existing callers.
- Added focused Windows regression coverage for worker URLs, project storage
  paths, MCP graph status, and update-verification commands.
- The native indexer now creates its DB parent on a fresh installation instead
  of depending on a human-memory store having run first.
- Git freshness queries are bounded natively and fail closed as `STALE` on Git
  errors/timeouts instead of silently certifying a graph as fresh.

### CONF-R169-007 — documentation authority

- R169B is merged on `main` at
  `15a732d91984e5b4ffa29b4e129ac0d6316c9fca`; it is no longer described
  as planned, pending merge, or an active product path.
- The **MERGED / INACTIVE** boundary is now explicit: R169B provides reserve,
  prepare/WAL/validate, fd copy+hash, temp fsync, no-clobber link, metadata,
  manifest, CAS, GC, and recovery primitives, with storage/concurrency/crash
  tests and a publication benchmark. No production indexer or reader calls
  those primitives.
- The active product boundary is unchanged: `indexProjectWasm`, UI, CLI,
  MCP, and readers still use the legacy `<project>.db` through
  `defaultCodeDbPath`; full product publication remains non-atomic.
- R169C indexer integration, R169D reader/lifecycle cutover, and R169E
  integrated crash/concurrency/performance/activation gating are future work.
- Corrected the publisher protocol in the canonical docs: staging is not
  renamed into `generations/`; the publisher copies+hashes through fds into
  an exclusive temp, fsyncs it, and creates the final entry with a
  no-clobber `link` before metadata/manifest/CAS completion.
- Corrected repository-maintenance documentation and configuration: Dependabot
  scheduled version updates are grouped, weekly, and bounded per ecosystem;
  repository-level security updates remain enabled.
- Added `tests/ci/r169-canonical-documentation.test.ts` to lock the four
  canonical documents against stale R169B merge/status, promotion, and
  historical step-header claims.

---

## Older releases

Entries from 0.75.0 through 0.12.0 are preserved in the
[historical changelog](../docs/history/changelog/CHANGELOG_0.12.0_TO_0.75.0.md).
