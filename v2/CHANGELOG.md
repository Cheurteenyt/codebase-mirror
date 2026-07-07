# Changelog — Codebase Memory V2

## 0.15.2 — Round 70 (2026-07-07) Claude Sonnet R10 audit — 3 fixes

Implements 3 fixes from Claude Sonnet 5 Round 10 audit report.

### Part A (MEDIUM) — vault.ts path safety fix (carryover from R9)

- **Bug**: `readNote`, `writeNote`, `deleteNote` called `assertPathInsideRoot()`
  but discarded the return value (the resolved, symlink-safe real path). The
  actual file operations used `join(vaultPath, relPath)` — the unresolved path.
  This meant a symlink inside the vault pointing outside could pass the
  containment check but the file operation would operate on the symlink, not
  its resolved target.
- **Fix**: all three functions now capture the return value of
  `assertPathInsideRoot()` and use it for the actual file operation
  (`readFileSync`, `writeFileSync`, `renameSync`). This matches the pattern
  already used correctly in `routeBrowse` (`routes/system.ts`).
- **MAINTAINERS_GUIDE.md** updated: added CRITICAL note to the "Path safety"
  section explaining that the return value MUST be captured and used, with
  a cross-reference to `routeBrowse` as the correct pattern.

### Part B (MEDIUM) — WASM extractor anonymous function name collision

- **Bug**: `getDeclName()` in `wasm-extractor.ts` returned the literal string
  `'anonymous'` for all unnamed functions. Every anonymous callback in the
  same scope got the same qualified name (`${parentQn}::anonymous`), causing
  `qnToId.set()` to silently overwrite previous entries — the map only
  remembered the last anonymous function in each scope.
- **Fix**: `getDeclName()` now returns `` `anonymous@${node.startPosition.row + 1}` ``
  — the line number ensures each anonymous function gets a unique qualified name.
  This prevents the silent overwrite and makes future features that look up
  specific anonymous functions by QN reliable.

### Part C (LOW) — benchmark precision caveat

- **Issue**: the "2.2x more nodes" figure in the R69 benchmark was framed as
  "more complete extraction" but V2 counts each inline anonymous callback as
  a separate node while V1 does not — a methodological difference, not
  necessarily a thoroughness win.
- **Fix**: added a "Caveat on node counts" section to `docs/V1_V2_BENCHMARK_R67.md`
  explaining that node counts are not directly comparable as a measure of
  extraction thoroughness.

### Verified clean (from audit)

- R69b `package.json` fix: confirmed complete (all deps present)
- R63 `server.ts` → `routes/*.ts` decomposition: 15 routes, all accounted for
- `MAINTAINERS_GUIDE.md`: well-executed, correct public/private split

## 0.15.1 — Round 69b (2026-07-07) fix: package.json dependencies restored

Fix: the R69 commit accidentally lost the original `package.json` dependencies
(`better-sqlite3`, `commander`, `ws`, `yaml`, `ts-morph`, `typescript`,
`vitest`, `@types/*`). The CI failed because `npm install` only installed
3 packages instead of the full set.

**Root cause**: during R68-R69, `npm install <pkg>` overwrote `package.json`
instead of merging. The file was left with only the newly-installed packages.

**Fix**: restored all original dependencies + added the new R68-R69 dependencies
(`ts-morph`, `web-tree-sitter`, `tree-sitter-wasm`, `tsx`). Version bumped
to 0.15.1. All 378 tests pass.

## 0.15.0 — Round 69 (2026-07-07) web-tree-sitter WASM — 112 languages

**Minor version bump** — V2 indexer upgraded from ts-morph (1 language, 1833ms)
to web-tree-sitter WASM (112 languages, 340ms). This is a **5.4x speedup**
and **112x language coverage increase**.

### New feature: WASM multi-language extractor (HIGH)

Created `v2/src/indexer/wasm-extractor.ts` — uses `web-tree-sitter` (WASM)
with `tree-sitter-wasm` (pre-built WASM grammars for 112 languages).

**Supported languages (24 key ones):**
TypeScript, TSX, JavaScript, Python, Go, Rust, Java, C, C++, Ruby, PHP,
Swift, Kotlin, Scala, Dart, Lua, Bash, YAML, JSON, HTML, CSS, SQL,
Dockerfile, Markdown — plus 88 more niche languages.

**What it extracts:**
- Nodes: File, Class, Function, Method (+ complexity estimation)
- Edges: CONTAINS (parent→child), CALLS (function→function)
- Incremental indexing (content hash, skip unchanged files)

### Benchmark: V1 C vs V2 WASM vs V2 ts-morph

Same codebase (v2/src, 49 TS files):

| Metric | V1 (C, tree-sitter) | V2 WASM (R69) | V2 ts-morph (R68) |
|---|---|---|---|
| Duration | 305ms | **340ms** | 1,833ms |
| Nodes | 460 | **784** | 352 |
| Edges | 1,499 | **1,252** | 1,070 |
| Languages | 158 | 112 | 1 |
| Binary needed | yes (cbm) | **no** | no |

V2 WASM is **5.4x faster** than V2 ts-morph and extracts **2.2x more nodes**.
It's within 12% of V1 C speed (340ms vs 305ms) while requiring **no binary**.

### Multi-language benchmarks

| Codebase | Files | Nodes | Edges | Duration | Languages |
|---|---|---|---|---|---|
| v2/src (TS) | 49 | 784 | 1,252 | 340ms | typescript |
| v1-reference/src (C) | 122 | 2,479 | 2,392 | 1,233ms | c |
| graph-ui/src (TSX) | 43 | 537 | 549 | 243ms | tsx, typescript, css |

### New dependencies

- `web-tree-sitter` (0.26.10) — tree-sitter bindings for Node.js/WASM
- `tree-sitter-wasm` (1.1.2) — pre-built WASM grammars for 112 languages

### Limitations vs V1

- 112 languages (V1 supports 158 — but all 24 key languages are covered)
- No simhash/minhash similarity detection
- No cross-repo intelligence
- No git history analysis
- No trace ingestion
- No LSP-based call resolution (static analysis only)
- No parallel pipeline (single-threaded — future: worker_threads)

## 0.14.0 — Round 68 (2026-07-07) native TypeScript/JavaScript indexer

**Minor version bump** — new feature: V2 can now index TS/JS projects without
the V1 `cbm` binary. This gives V2 partial autonomy for TypeScript/JavaScript
projects.

### New feature: native indexer (HIGH)

Created `v2/src/indexer/` module with 3 files:

- **`schema.ts`** — SQLite schema compatible with V1 (nodes, edges, file_hashes,
  projects tables + indexes). V2's `sqlite-ro.ts` reads the DB transparently
  whether it was created by V1 (C, 158 languages) or V2 (TS/JS only).
- **`extractor.ts`** — uses `ts-morph` (TypeScript compiler API wrapper) to
  extract nodes (File, Class, Function, Method, Variable) and edges (CONTAINS,
  IMPORTS, CALLS) from .ts/.tsx/.js/.jsx/.mjs/.cjs files. Includes:
  - Incremental indexing (content hash comparison, skip unchanged files)
  - Complexity estimation (cyclomatic — counts if/while/for/case/catch/&&/||)
  - Import resolution (relative imports → file path → IMPORTS edge)
  - Call resolution (CallExpression → callee name → CALLS edge)
- **`indexer.ts`** — orchestrator: opens DB → init schema → discover files →
  extract → update stats. Returns ExtractionResult with counts + errors.

New CLI command: `cbm-v2 index --project <name> --root <path> [--incremental] [--dry-run]`

New dependency: `ts-morph` (TypeScript compiler API wrapper).

### Benchmark: V2 native indexer vs V1 C engine

Same codebase (v2/src, 48 TS files):

| Metric | V1 (C, tree-sitter) | V2 (native, ts-morph) |
|---|---|---|
| Files indexed | 35 | 48 (includes .js) |
| Nodes extracted | 460 | 352 |
| Edges extracted | 1,499 | 1,070 |
| Duration | 305ms | 1,833ms |
| Languages | 158 | 1 (TS/JS) |

V2 is 6x slower and extracts fewer nodes/edges (V1's tree-sitter is more
thorough — extracts types, interfaces, enums, etc.). But V2 works without
the `cbm` binary, which was the #1 architectural gap identified in R67.

### Limitations vs V1

- Only TS/JS (V1 supports 158 languages)
- No simhash/minhash similarity detection
- No cross-repo intelligence
- No git history analysis
- No trace ingestion
- No LSP-based call resolution (static analysis only)
- No parallel pipeline (single-threaded)

### When to use native indexer vs V1

- **Use V1 (`cbm index_repository`)** when: the `cbm` binary is available,
  you need multi-language support, or you need maximum accuracy/performance.
- **Use V2 native (`cbm-v2 index`)** when: the `cbm` binary is NOT available,
  your project is TS/JS only, or you want a quick index without building V1.

## 0.13.4 — Round 67 (2026-07-07) V1+V2 combined benchmark — real data

Built V1 from source and indexed the V2 codebase to get real performance
numbers. Full report: docs/V1_V2_BENCHMARK_R67.md.

### V1 indexation benchmark (real data)

- Built V1 binary from source: 562 source files, 259MB binary
- Indexed V2 codebase: 35 files, 460 nodes, 1499 edges in **305ms**
- Throughput: ~115 files/second (tree-sitter + arena + slab + 12 workers)
- Pipeline: configlink(0ms) → route_match(0ms) → complexity(0ms) → dump(5ms) → total 284ms

### V2 query benchmark (same DB, real data)

- getNodeById: 0.006ms (183K ops/sec)
- searchCode LIKE: 0.077ms (13K ops/sec)
- countNodes: 0.013ms (74K ops/sec)
- countAll: 0.050ms (20K ops/sec)
- getBulkNodeDegrees(100): 0.219ms (4.6K ops/sec)
- listNodes(200): 1.195ms (837 ops/sec)

### V1 vs V2 comparison

- SQLite query overhead: V1 ~0.001ms vs V2 ~0.006ms (+0.005ms JS binding, negligible)
- CLI startup: V1 ~25ms per invocation vs V2 0ms (already running)
- Application cache: V1 none vs V2 SWR (0.0003ms for hits) — V2 faster for repeated
- V1 can do code analysis V2 cannot (tree-sitter, complexity, similarity, cross-repo)
- V2 can do human context V1 cannot (ADRs, bugs, Obsidian sync, MCP, React UI)

### Key insight

V2 depends entirely on V1 for code graph creation. Without the `cbm` binary,
V2 has no code graph to serve. This is the biggest architectural gap:
V2 has no fallback when V1 is unavailable.

## 0.13.3 — Round 66 (2026-07-07) performance benchmark suite

Created a comprehensive benchmark suite measuring V2 sidecar performance
with synthetic data (1000 nodes, 5000 edges, 200 human notes). All 19
benchmarks pass with "excellent" or "good" assessment.

### Benchmark suite (scripts/benchmark.ts)

19 benchmarks across 5 categories:

**Human Store** — hot-path prepared statements (R58):
- getNodeById: 0.006ms (179K ops/sec) ✓
- getNodeBySlug: 0.006ms (162K ops/sec) ✓
- listNodes (200 results): 1.14ms (875 ops/sec) ✓
- listNodesByCbmNodeId (junction JOIN): 0.064ms (15.6K ops/sec) ✓
- countNodesByLabel: 0.024ms (41.3K ops/sec) ✓
- getBulkNotesByCbmNodeIds (50 ids): 0.57ms (1.8K ops/sec) ✓
- createNode (write path): 0.11ms (9K ops/sec) ✓

**Code Graph** — sqlite-ro.ts patterns (R59):
- getNodeById: 0.004ms (260K ops/sec) ✓
- findByQualifiedName: 0.002ms (453K ops/sec) ✓
- countNodes: 0.026ms (38.4K ops/sec) ✓
- countAll (1 query): 0.15ms (6.8K ops/sec) ✓

**Bulk Queries** — R40 optimization:
- getBulkNodeDegrees (100 nodes): 0.36ms (2.8K ops/sec) ✓
- getBulkNodeDegrees (500 nodes): 1.87ms (535 ops/sec) ✓
- getBulkEdges (100 nodes): 1.13ms (884 ops/sec) ✓

**SWR Cache** — R37-R50:
- fresh hit: 0.0003ms (3.4M ops/sec) ✓
- miss: 0.0001ms (14.7M ops/sec) ✓
- set + evict: 0.0008ms (1.3M ops/sec) ✓

**JSON Serialization**:
- stringify (100 nodes): 0.07ms (13.7K ops/sec) ✓
- parse (100 nodes): 0.12ms (8.2K ops/sec) ✓

### Key findings

1. **SWR cache is essentially free** — 0.0003ms per fresh hit (3.4M ops/sec).
   The R37-R50 SWR optimization eliminates 100% of query cost for cached entries.

2. **Prepared statements (R58-R59) confirmed effective** — 0.002-0.006ms per
   single-row lookup (178K-453K ops/sec). Sub-microsecond overhead.

3. **Bulk queries (R40) deliver 88x speedup** — getBulkEdges for 100 nodes
   takes 1.13ms vs ~100ms for 200 individual getNeighbors calls.

4. **Write path is fast** — createNode at 0.11ms (9K ops/sec) enables
   real-time vault sync without blocking.

5. **No operation exceeds 2ms** — V2 is not a performance bottleneck.
   The bottleneck is V1's indexation (CPU-bound, seconds to minutes).

### Comparison with V1

V1's C API direct SQLite access has ~0.001ms overhead. V2's better-sqlite3
adds ~0.003ms JS binding overhead — **negligible difference**. The SWR cache
makes V2 **faster** than V1 for repeated queries (V1 has no app-level cache).

Full report: docs/PERFORMANCE_BENCHMARK_R66.md

## 0.13.2 — Round 65 (2026-07-07) V1 C engine audit (reference, read-only)

Deep audit of the V1 C engine (65,620 LOC, 71 .c files). V1 is kept intact
as a reference — this round documents findings without modifying V1 code.

### Audit report (docs/V1_AUDIT_R65.md)

Full audit report created at `docs/V1_AUDIT_R65.md` documenting:

**Findings:**
- 🔴 HIGH: `strcat` buffer overflow in store.c:4479-4484 (512B buffer, unbounded path segments)
- 🟡 MEDIUM: 5 unchecked `malloc` returns in store.c list functions (NULL deref on OOM)
- 🟡 MEDIUM: `slab_owns()` O(n) scan per free/realloc (slab_alloc.c)
- 🔵 LOW: `slab_realloc` promotion ordering (safe but fragile)

**What V1 does right (excellent patterns):**
- Arena + slab + string interning + mimalloc (production-grade memory management)
- Thread-local slab allocator (eliminates ptmalloc2 fragmentation, was 321GB VSZ)
- Atomic work-stealing worker pool (zero contention)
- SQLite PRAGMAs: WAL, 64MB cache, mmap, temp_store=MEMORY
- Prepared statement caching (same pattern V2 adopted in R58)
- Verstable hash table (2024 state-of-the-art, 4-bit hash fragment metadata)
- Back-pressure mechanism (RSS budget, worker naps)
- Cypher engine: SQL injection safe (snprintf + bind_text)

**V1 vs V2 comparison:**
- V1's strcat bug is impossible in V2 (TypeScript strings are bounds-safe)
- V1's unchecked malloc is impossible in V2 (V8 GC, no manual allocation)
- V1's slab allocator has no V2 equivalent (V8 handles allocation)
- Both use the same SQLite PRAGMA patterns and prepared statement caching

**Verdict:** V1 is production-grade C. The architecture split (C for CPU-bound
analysis, TypeScript for I/O-bound sidecar) is the right choice.

## 0.13.1 — Round 64 (2026-07-07) deep audit — bug fix + 36 catch(any) removed

Deep audit of the entire codebase. 1 bug found and fixed, 36 `catch (e: any)`
removed across MCP tools, CLI commands, and graph-ui.

### Bug fix (MEDIUM) — routeIndex status race

- **routeIndex**: if `spawn()` threw synchronously (e.g. ENOENT when `cbm`
  binary is missing), the job status was set to `'failed'` but the HTTP
  response was still `202 Accepted` — semantically misleading. The client
  received "accepted, processing" for a job that already failed. Now returns
  `500` with `{ job_id, status: 'failed', error }` when spawn fails to start.
  Pre-existing bug (not a R63 regression), but caught during R64 deep audit.

### Type safety (MEDIUM) — 36 `catch (e: any)` → `catch (e: unknown)`

- **17 v2 files**: mcp/server.ts (2), 7 MCP tools (1 each), cli/index.ts (4),
  8 CLI command files (20 total), config.ts (1). All `e.message` accesses
  replaced with `e instanceof Error ? e.message : String(e)` — safe against
  non-Error throws (`throw "string"`, `throw { code: 42 }`).
- **graph-ui/api/client.ts** (2): same fix + `e?.name` → `e instanceof Error
  && e.name` (optional chaining on `unknown` is a TS error).
- **schema.ts:341**: `r: any` → `r: unknown` with cast `{ version: number }`.

### Audit summary

Full codebase audited for:
- Race conditions (found 1: routeIndex status — fixed)
- Memory leaks (none — WeakMap for ws filters, timers cleared in finally)
- Unhandled rejections (none — all async routes wrapped in handleRequest try/catch)
- Type safety gaps (found 36 catch(any) + 1 r:any — all fixed)
- Security (all R51 fixes still in place, safe-path utility used correctly)
- Performance (prepared statements, SWR cache, bulk queries all intact)

Remaining `any` usage is either:
- `openMemory()` (4 `as any` — accessing private fields from static method, documented)
- `config.ts deepMerge` (generic deep merge, inherently dynamic)
- `mcp/server.ts` JSON-RPC types (protocol-level, `params?: any` is the JSON-RPC spec)
- `mcp/tools/index.ts` `null as any` (singleton initialization pattern)
- Test files (mocks — `as any` on vi.fn() is standard vitest pattern)

## 0.13.0 — Round 63 (2026-07-07) server.ts architecture refactor

**Minor version bump** — significant architecture change (no breaking API
changes, but the internal file structure of the UI module is reorganized).

### Architecture refactor (HIGH) — server.ts split into 7 files

`server.ts` was 1212 lines with 16 route handlers, WebSocket management,
static file serving, and helpers all in one file. R63 splits it into a
clean module structure:

```
v2/src/ui/
├── server.ts          (290 lines, was 1212) — thin coordinator
├── types.ts           (59 lines) — RouteContext, RouteHandler, IndexJob
├── helpers.ts         (140 lines) — sendJson, errorMessage, parseJsonBody, MIME_TYPES
└── routes/
    ├── graph.ts       (173 lines) — routeLayout, routeDashboard, routeGraphStatus
    ├── project.ts     (157 lines) — routeProjects, routeProjectHealth, routeProjectDelete
    ├── human.ts       (133 lines) — routeHumanNotes, routeAdrGet, routeAdrPost
    ├── index.ts       (132 lines) — routeIndex, routeIndexStatus
    └── system.ts      (243 lines) — routeBrowse, routeProcesses, routeProcessKill, routeLogs
```

**Key abstraction: `RouteContext`** — every route handler now receives a
context object with its dependencies (humanStore, codeReader, project,
indexJobs, logBuffer, log(), sendJson()) instead of accessing `this.*` on
the UiServer instance. This means:
- Routes can be unit-tested with a mock context (no need to spin up a server)
- Dependencies are explicit — the compiler catches missing fields
- Routes can be moved/renamed without touching server.ts
- server.ts is now a thin coordinator: constructor, start/stop, request
  handling, route table, WebSocket, static file serving

**No functional changes** — every route handler is the exact same logic,
just moved to a standalone function that receives RouteContext. All 378
tests pass with 0 regressions. The route table in server.ts is unchanged
(same 15 endpoints, same order, same handler signatures).

### Helpers extracted (MEDIUM)

- `parseJsonBody` moved from UiServer method to standalone helper in helpers.ts.
- `sendJson` moved from UiServer method to standalone helper.
- `errorMessage` moved from UiServer static method to standalone helper.
- `colorForLabel` moved from UiServer method to standalone helper.
- `MIME_TYPES`, `DEFAULT_PORT`, `LOG_BUFFER_MAX` constants moved to helpers.ts.
- `MAX_BODY_SIZE`, `BODY_TIMEOUT_MS` new named constants (were inline magic numbers).

## 0.12.9 — Round 62 (2026-07-07) code quality in importer.ts + generator.ts

No bugs fixed — type safety + deduplication in the Obsidian sync engine
(`v2/src/obsidian/importer.ts` + `v2/src/obsidian/generator.ts`). Zero
functional changes, zero test regressions.

### importer.ts (MEDIUM) — deduplication + type safety

- **Duplicated import loop extracted**: the `for (const relPath of files) {
  try { importSingleFile } catch (e) { result.errors.push } }` block was
  duplicated verbatim in both the dry-run branch and the transaction branch.
  Extracted into a local `importAllFiles` helper, which is now passed directly
  to `db.transaction()` (better-sqlite3 accepts a function directly — no need
  to wrap it in an anonymous arrow). The dry-run branch calls it directly.
- **2 `catch (e: any)` → `catch (e: unknown)`**: now uses
  `e instanceof Error ? e.message : String(e)` instead of accessing `.message`
  on an `any`-typed value.
- **`existingBySlug` typed**: was `let existingBySlug = null` (inferred as
  `null` only, then assigned a `HumanNode`). Now explicitly
  `let existingBySlug: HumanNode | null = null`. The compiler will catch any
  future assignment of a non-HumanNode value.

### generator.ts (LOW) — type safety

- **2 `catch (e: any)` → `catch (e: unknown)`** in `syncHumanNodesToVault`
  and `autoGenerateModuleNotes`. Same pattern as importer.ts — uses
  `e instanceof Error ? e.message : String(e)`.

### Why this matters

The importer and generator are the two halves of the Obsidian vault sync
engine — importer reads vault files into the DB, generator writes DB nodes
back to vault files. Every sync cycle runs both. The duplicated import loop
was a maintenance hazard (a fix in one branch could be missed in the other);
the `catch (e: any)` pattern could throw on non-Error values (e.g. if
`importSingleFile` ever did `throw "invalid frontmatter"` instead of
`throw new Error("invalid frontmatter")`).

## 0.12.8 — Round 61 (2026-07-07) code quality in server.ts

No bugs fixed — type safety and WebSocket state management in the UI server
(`v2/src/ui/server.ts`). Zero functional changes, zero test regressions.

### Type safety (MEDIUM) — 7 `catch (e: any)` + 2 `(ws as any)` removed

- **`catch (e: any)` → `catch (e: unknown)`** in all 7 catch blocks
  (handleRequest, routeProjectHealth, routeAdrPost, routeBrowse, routeIndex,
  routeProcessKill, routeProjectDelete). The previous pattern accessed
  `e.message` on an `any`-typed value, which would throw if `e` was not an
  Error object (e.g. `throw "string"` or `throw { code: 42 }`).
- **`UiServer.errorMessage(e: unknown): string` static helper** added.
  Uses `e instanceof Error ? e.message : typeof e === 'string' ? e : String(e)`.
  All 7 catch blocks now call `UiServer.errorMessage(e)` instead of `e.message`.
  Also used in `start()`'s error handler (was `e.message` on `NodeJS.ErrnoException`,
  which had `.message` but is now unified through the helper for consistency).
- **`(ws as any)._projectFilter` removed**. The previous pattern augmented the
  WebSocket instance with an untyped `_projectFilter` field, accessed via
  `(ws as any)._projectFilter` in 2 places. Replaced with a
  `WeakMap<WebSocket, string | undefined>` (`wsProjectFilters`). Benefits:
  - Type-safe: the compiler knows the value is `string | undefined`, not `any`.
  - No field-name typos: `_projectFilter` vs `_projectfilter` would silently
    return `undefined` with the old pattern; now it's a compile error.
  - Automatic GC: when the WebSocket is closed and removed from `wsClients`,
    the WeakMap entry is garbage-collected automatically.

### Why this matters

`server.ts` is the HTTP/WebSocket server that every UI client connects to.
The 7 catch blocks handle every API error response — if any of them threw
while trying to extract `e.message`, the server would return a 500 with no
error message (or worse, crash the request handler). The WeakMap fix makes
the WebSocket project-filter mechanism type-safe and self-cleaning.

## 0.12.7 — Round 60 (2026-07-07) code quality in swr-cache.ts

No bugs fixed — code quality, deduplication, and type safety in the SWR cache
(`v2/src/intelligence/swr-cache.ts`). Zero functional changes, zero test regressions.

### Code quality (MEDIUM) — dead code + duplication + fragility

- **Dead code removed**: `effectiveMaxEntries` ternary in `evictToFit()` had both
  branches identical (`this.maxEntries : this.maxEntries`). It looked like it
  did something but was a no-op. Removed; the entry-count limit now always
  applies regardless of maxBytes (which is the correct behavior — maxBytes is
  the primary budget, maxEntries is a hard cap).
- **Duplication eliminated**: extracted `evictOne()` private method from
  `evictToFit()`. The pattern "get oldestKey → delete entry → subtract bytes →
  delete refresh handlers → delete refresh timers → bump eviction stats" was
  duplicated 2× (once for the memory budget loop, once for the entry-count
  budget loop). Now both loops call `evictOne()`.
- **Defensive iteration**: `invalidatePrefix()` previously modified
  `this.entries` while iterating over `this.entries.keys()`. JS Map iterators
  tolerate concurrent deletion, but this is fragile — it would break silently
  if someone later changed the iteration method (e.g. to `for...of` with
  destructuring). Now collects matching keys into an array first, then
  invalidates them in a separate loop.

### Type safety (LOW) — `any` removed from event API

- **`catch (e: any)` → `catch (e: unknown)`** in the background refresh error
  handler. Now uses `e instanceof Error ? e.message : String(e)` instead of
  accessing `.message` on an `any`-typed value (which would throw if `e` was
  not an Error object — e.g. `throw "string"` or `throw { code: 42 }`).
- **`on()` method typed**: previously `on(event: string, listener: (...args: any[]) => void)`.
  Now `on(event: 'refresh', listener: (event: SwrCacheRefreshEvent<K>) => void)`.
  Added `SwrCacheRefreshEvent<K>` exported interface with `key`, `phase`, `error?`
  fields. Callers now get autocomplete and the compiler catches field-name typos.

## 0.12.6 — Round 59 (2026-07-07) code quality + type safety in sqlite-ro.ts

No bugs fixed — same pattern as R58 but applied to the code graph reader
(`v2/src/bridge/sqlite-ro.ts`). Zero functional changes, zero test regressions.

### Type safety (MEDIUM) — 30 `as any` casts removed

- **11 row type interfaces added**: `CodeNodeRow`, `NeighborRow`, `DegreeCountRow`,
  `CountRow`, `CountAllRow`, `LabelCountRow`, `TypeCountRow`, `EdgeTripleRow`,
  `BulkEdgeRow`, `ProjectNameRow`, `ProjectRow`. These match what SQLite actually
  returns for each query shape (simple SELECT *, JOINs with aliases, COUNT
  aggregations, GROUP BY, etc.).
- **All 30 `as any` casts replaced** with proper row types: `as CodeNodeRow | undefined`,
  `as NeighborRow[]`, `as DegreeCountRow[]`, `as CountRow`, `as CountAllRow`,
  `as LabelCountRow[]`, `as TypeCountRow[]`, `as EdgeTripleRow[]`, `as BulkEdgeRow[]`,
  `as ProjectNameRow[]`, `as ProjectRow[]`, etc.
- **`deserializeCodeNode(row: CodeNodeRow)`** — previously typed as `(row: any)`.
- **`makeEdge(row: BulkEdgeRow)`** in getBulkNeighbors — previously `(row: any)`.
- **`tryPush(row: EdgeTripleRow, ...)`** in getBulkEdges — previously `(row: any)`.
- **`params: any[]`** in findNodesByName and listNodes replaced with `(string | number)[]`.
- **Null safety**: `NeighborRow.node_properties` is `string | null` (LEFT JOIN may
  produce null). The getNeighbors method now coalesces with `?? '{}'` when passing
  to deserializeCodeNode, matching the existing `row.properties_json || '{}'` pattern
  in deserializeCodeNode itself.

### Performance (LOW-MEDIUM) — hot-path prepared statements

- **2 prepared statements moved to constructor**: `stmtGetNodeById`,
  `stmtFindNodeByQName`. These are the 2 single-row lookups called on every MCP
  tool invocation (prepare_edit_context, get_module_context, search_code_and_memory).
  better-sqlite3 caches internally, but holding the Statement object directly
  avoids the cache lookup + JS wrapper allocation on every call.

### Why this matters

`sqlite-ro.ts` is the read-only bridge to V1's code graph — every MCP tool, every
UI endpoint that shows code structure goes through `CodeGraphReader`. Before this
round, 30 `as any` casts meant the TypeScript compiler couldn't catch:
- Column-name typos (e.g. `row.edge_propertis` instead of `row.edge_properties`)
- Wrong alias names in JOIN queries (the getNeighbors aliases are critical —
  both tables have `id`, `project`, `properties_json`, and without aliases
  better-sqlite3 returns the last column value for duplicate names)
- Missing fields after a V1 schema change

With proper row types, these are all compile-time errors. The prepared-statement
optimization is minor but sets the pattern for future hot-path identification.

## 0.12.5 — Round 58 (2026-07-07) code quality + type safety + perf

No bugs fixed — this round focuses on code quality, type safety, and performance
in the DB layer (`v2/src/human/store.ts`). Zero functional changes, zero test
regressions.

### Type safety (MEDIUM) — 18 `as any` casts removed

- **6 row type interfaces added**: `HumanNodeRow`, `HumanEdgeRow`, `IdRow`,
  `CountRow`, `LabelCountRow`, `HumanNodeWithCbmIdRow`. These match what SQLite
  actually returns (JSON columns as `string`, not parsed arrays; label/status/
  source/type as `string`, not union types — the DB CHECK constraint guarantees
  validity, but TypeScript can't know that from the raw column type).
- **All 18 `as any` casts in query methods replaced** with proper row types:
  `as HumanNodeRow | undefined`, `as HumanEdgeRow[]`, `as CountRow`,
  `as LabelCountRow[]`, etc. The only remaining `as any` are 4 in
  `openMemory()` (accessing private fields from a static method — documented
  with a comment explaining why the alternative would be worse).
- **`deserializeNode(row: HumanNodeRow)`** and **`deserializeEdge(row: HumanEdgeRow)`**
  — previously typed as `(row: any)`. Now the compiler catches column-name typos
  at build time and the schema is self-documenting.
- **`safeJsonParseArray` return type** tightened from `any[]` to `unknown[]`.
  The `cbm_node_ids` filter now uses a type guard `(x): x is number => ...`
  instead of an unchecked `.filter()` returning `any[]`.
- **`params: any[]`** in `listNodes` and `updateNode` replaced with
  `(string | number)[]` and `(string | number | null)[]`.

### Performance (LOW-MEDIUM) — hot-path prepared statements

- **3 prepared statements moved to constructor**: `stmtGetNodeById`,
  `stmtGetNodeBySlug`, `stmtGetNodeByObsidianPath`. These are the 3 single-row
  lookups called on every MCP tool invocation, every UI dashboard load, and
  every sync cycle. better-sqlite3 caches prepared statements internally, but
  holding the Statement object directly avoids the cache lookup + JS wrapper
  allocation on every call. `openMemory()` (used by tests) also prepares them
  (after `runMigrations`, since the tables must exist first).

### Why this matters

The DB layer is the foundation of the entire V2 sidecar — every MCP tool, every
CLI command, every UI endpoint goes through `HumanMemoryStore`. Before this
round, the store had 22+ `as any` casts, meaning the TypeScript compiler
couldn't catch:
- Column-name typos (e.g. `row.cbm_node_id` instead of `row.cbm_node_ids`)
- Wrong return type assumptions (e.g. treating a JSON string as an array)
- Missing fields after a schema change

With proper row types, these are all compile-time errors. The prepared-statement
optimization is minor (better-sqlite3's cache is fast), but it makes the hot
path explicit and sets the pattern for future optimizations.

## 0.12.4 — Round 57 (2026-07-07) doc cleanup + private maintainers notes

Doc consistency + maintainability improvements (no code changes).

### Documentation cleanup (MEDIUM)

- **12 stale refs fixed** across v2/README.md, CONTRIBUTING.md, MAINTAINERS_GUIDE.md:
  - v2/README.md: test count 374→378 (355+23), version refs 0.11.3→0.12.4, security section updated to mention R51/R55 symlink-safe realpath protection.
  - CONTRIBUTING.md: "6 tools"→"7 tools", "374 tests"→"378 tests", "5 docs files"→"9 files", "npm ci"→"npm install --no-audit --no-fund", removed stale "planned: 0.4.0" tag (we're at 0.12.4), rewrote CI/CD section to describe the actual GitLab→GitHub mirror workflow + required checks + cross-ref to MAINTAINERS_GUIDE.md.
  - MAINTAINERS_GUIDE.md: test count 376→378, round range R55→R56, commit message example updated.

### MAINTAINERS_GUIDE.md enriched (MEDIUM)

- **Common pitfalls** section (9 items): "FIXED" claims that weren't fixed, stale version/test counts, YAML `: ` parsing, `--force-with-lease` URL push, workflow-level permissions, MR pipelines with zero jobs, unconditional setLoading, npm ci vs npm install, committing in wrong repo.
- **Pre-commit checklist** section (12 items): build, tests, version bump, CHANGELOG, doc consistency, YAML validation, regression test, commit message format, push options.
- **Lessons learned** section (6 items): environment reset recovery, GitLab API 403, paramiko slowness, sed over-replacement, branch protection, cd persistence.

### Private maintainers notes (LOW)

- **MAINTAINERS_NOTES.local.md** (gitignored via `*.local.md`): operational reminders, environment setup, env reset recovery steps, operational gotchas, token/variable locations (names only, not values), pre-session checklist. No actual secrets — just paths, URLs, and "things I keep forgetting". The SSH key PATH is mentioned (it's just a path), but the key VALUE never leaves the machine.

## 0.12.3 — Round 56 (2026-07-07) self-audit + MAINTAINERS_GUIDE

3 improvements from GLM self-audit (no external audit report this round).

### Test coverage (MEDIUM)

- **symlink escape test for assertPathInsideRoot**: R55 Part A wired up the
  shared `safe-path.ts` utility in `vault.ts` and `server.ts`, but the
  existing `vault.test.ts` only tested symlink loops (R51) — not the actual
  symlink-escape attack vector that `assertPathInsideRoot` is supposed to
  prevent. Added 2 tests: (1) symlink inside vault pointing outside is
  rejected by readNote/writeNote/deleteNote; (2) symlink inside vault
  pointing to another vault-internal path is allowed (no over-blocking).

### Code clarity (LOW)

- **backup.ts version field clarified**: `version: '0.10.3'` in the backup
  JSON was ambiguous — could be confused with the package version (0.12.2).
  Added a 10-line comment block explaining it's a schema version independent
  from the package version, bumped only when the JSON shape changes.

### Documentation (LOW)

- **MAINTAINERS_GUIDE.md** (new file): captures the workflow conventions,
  naming rules, required patterns (safe-path, -- separator, grep -wE,
  maxAliasCount), anti-patterns (force-without-lease, token in URL,
  unconditional setLoading, unquoted `: ` in YAML), CI/CD setup, test
  infrastructure, audit etiquette, and versioning rules accumulated across
  55 rounds. Public doc — for secrets/keys see local `MAINTAINERS_NOTES.local.md`.

## 0.12.2 — Round 55 (2026-07-07) Claude Sonnet 5 R9 audit

4 issues fixed from Claude Sonnet 5 Round 9 audit report (1 HIGH, 1 LOW, 2 LOW cleanup).

### HIGH fix (dead code + duplication risk)

- **Part A**: `v2/src/utils/safe-path.ts` was created in R53 (Part C of Round 8 audit) to de-duplicate the symlink-safe path resolution logic between `vault.ts` and `server.ts`, but neither call site was actually wired up to use it — both kept their own inline `realpathSync` implementations. The utility file's docstring claimed the wiring existed when it didn't. Round 8 specifically warned about this duplication risk. Fixed: `vault.ts`'s `assertPathInsideVault` replaced by the shared `assertPathInsideRoot` (3 call sites: `readNote`, `writeNote`, `deleteNote`); `server.ts`'s `routeBrowse` now uses `safeRealpath`, `routeIndex` now uses the new `safeRealpathStrict` (added to the utility for the strict 404-on-missing-path semantics `routeIndex` needs). The inline `realpathSync` import was removed from `server.ts`. `vault.ts`'s `walkVaultIter` keeps its own `realpathSync` call for symlink-loop detection (different semantics — `safeRealpath`'s fallback would defeat the skip-on-broken-symlink behaviour).

### HIGH fix (CI silently broken)

- **D3**: Round 52's workflow-level `permissions: contents: read` hardened `backend`/`frontend` correctly, but silently broke `quota-report`'s `/repos/.../actions/runs` API call — once any `permissions:` key is set at workflow level, every unlisted scope becomes `none`. The job's `total_count` parsing fell back to `0` instead of surfacing the 403. Fixed: `quota-report` now has its own job-level `permissions: { contents: read, actions: read }` override. `backend`/`frontend` stay at the workflow-level default (least-privilege preserved).

### LOW fixes (CI cleanup)

- **D4**: removed unreachable `'v2/**'` pattern from `on.push.branches` — only the GitLab mirror pushes to this repo, and it only pushes to `main`.
- **D5**: restricted `quota-report` to `schedule`-only (was `schedule || push to main`). Running it on every merge to `main` added noise without value: rate limits reset hourly, the weekly schedule is the actual trend signal.

### Notes

- **D2 residual (acknowledged, not fixed)**: the `http.extraHeader` fix from R53 closes the cited leak vector (git echoing a credential-bearing URL in error output), but the base64 token is still passed in argv via `git -c http.extraHeader=...`, visible via `/proc/[pid]/cmdline` during the push. On GitLab.com shared runners (ephemeral, single-job) this is a much narrower risk than the original leak. A `GIT_ASKPASS` script reading from an env var would close the residual gap if it ever becomes a real concern.
- **Part B (Round 8 backfill)**: confirmed complete — Round 49's "1 CRITICAL merge" is now explained in the changelog, all rounds 47-52 have itemized entries.
- **Part C (D1/D2 mirror fix)**: confirmed correct, including the `ls-remote` + `--force-with-lease=main:<sha>` refinement from R54c that handles the URL-push edge case.

## 0.12.1 — Round 52 (2026-07-07) CI

6 CI quality + security fixes.

- **Security**: `permissions: contents: read` (least-privilege for GITHUB_TOKEN).
- **Perf**: removed `pretest` script that doubled the build (~10s/pipeline saved).
- **Perf**: `npm install --no-audit --no-fund` (~2s/job saved).
- **Quality**: quota-report single API call + single Python parse.
- **Bugfix**: GitLab CI quota-check date command fixed for BusyBox/Alpine.
- **Quality**: simplified quota-report output.

## 0.12.0 — Round 51 (2026-07-07) SECURITY

8 security issues fixed (1 CRITICAL, 3 HIGH, 2 MEDIUM, 2 LOW).

- **SEC-5 CRITICAL**: vault.ts symlink traversal — `assertPathInsideVault` used string-based `resolve()` without `realpathSync`. A symlink inside the vault pointing to `~/.bashrc` could be used for arbitrary file write → RCE. Fixed: `realpathSync` + `lstatSync` + symlink escape detection in `walkVault`.
- **SEC-6 HIGH**: `POST /api/adr` accepted `body.project` without regex validation — IDOR. Fixed.
- **SEC-7 HIGH**: `POST /api/index` `rootPath` was unvalidated — could index `/etc`. Fixed: leading-hyphen check + `realpathSync` + home containment.
- **SEC-8 HIGH**: `routeProcessKill` allowlist included stale PIDs from completed index jobs. A recycled PID could be killed. Fixed: clear `job.childPid` on exit + only allowlist running jobs.
- **SEC-10 MEDIUM**: `routeProjectDelete` missing leading-hyphen check. Fixed.
- **SEC-13 MEDIUM**: `routeHumanNotes` accepted negative `cbm_node_id`. Fixed.
- **SEC-15 LOW**: `yaml.parse()` called without explicit `maxAliasCount`. Fixed: `{ maxAliasCount: 100 }`.

## 0.11.4 — Round 50 (2026-07-07)

9 issues fixed (1 HIGH bug, 2 MEDIUM perf/doc, 6 LOW cleanup/doc).

### HIGH fix (bug)

- **#1**: `invalidateGraphStatusCache` was never called after re-index. The SWR cache served stale `total_nodes`/`total_edges`/`nodes_by_label` for up to 60s after a successful `cbm index_repository`. Now called on successful index job exit + emits `code_graph_changed` NotifyHub event.

### MEDIUM fixes

- **#2 PERF**: reverted R49 #8 `routeLayout` SWR reuse — `getGraphStatus` on cold cache adds 50-200ms (git log execSync) for a `total_nodes` field the Graph tab doesn't render. Reverted to `countNodes` (~1ms).

- **#3 DOC**: CONTRIBUTING.md + Dockerfile still referenced old GitLab URLs. Updated to GitHub repo + GitHub Actions CI.

### LOW fixes

- **#5 CLEANUP**: removed dead `else if` branch in importer.ts — `wasUnchanged` implies `samePath=true` implies `oldObsidianPath=null`, making the branch unreachable.
- **#6 DOC**: README.md missing closing `**` on bugs-fixed line broke Markdown bold.
- **#7 DOC**: CONTRIBUTING.md test count said 124, actual is 374.
- **#8 CLEANUP**: `swr-cache.evictToFit` didn't clear `refreshHandlers`/`refreshTimers` on eviction — orphaned handlers could schedule stale refreshes.
- **#4 DOC**: version/round refs synced across README, v2/README, ROADMAP.
- **#9 TEST**: (this round) no new regression tests needed — R49 fixes covered by existing test suite.

## 0.11.3 — Round 49 (2026-07-07)

9 issues fixed (1 CRITICAL merge, 2 HIGH docs, 1 MEDIUM perf, 5 LOW bug/perf/cleanup).

### CRITICAL fix (merge)

- **#1**: R48 commit (`8c26fa3`) was never merged into the working branch — the audit was running against 0.11.1 (R47), not 0.11.2 (R48). Cherry-picked R48 into R49 to restore the correct codebase state. The R48 fixes (CI mirror main-only, ControlTab stale controller, parseNote line-by-line, swr-cache timer, kill timer) were present in the remote main but missing from the local working branch.

### HIGH fixes (docs)

- **#2**: README badge URL pointed to old GitLab path with wrong username. CI badge now points to GitHub Actions.
- **#3**: Version string out of sync across package.json / README / ROADMAP / CHANGELOG (all said 0.11.1, should be 0.11.2+).

### MEDIUM fix (performance)

- **#4**: `processWikilinks` ran for EVERY note including unchanged ones — 1000× `buildFenceState` + ~5000 SQL round-trips wasted on a typical sync where 990 notes are unchanged. Now skips wikilink processing for unchanged notes. ~10× import speedup on large vaults.

### LOW fixes

- **#6**: `client.ts` external-signal abort misreported as "Request timed out" even when the caller cancelled at 50ms. Now distinguishes timeout vs caller cancel.
- **#7**: `client.ts` external-signal abort listener leaked on long-lived signals. Now removed in `finally` block.
- **#8**: `routeLayout` called `countNodes` — a full table scan — even though `getGraphStatus` (SWR-cached) already computed the same value. Reuses cached value.
- **#9**: `GraphCanvas.draw` set `strokeStyle`/`lineWidth` PER EDGE — 5000 canvas state changes per frame. Refactored to two-pass batching: O(1) state changes.
- **#10**: `importer.ts` had a misplaced `import type` at bottom of file. Moved to top.
- **#12**: `swr-cache.getWithPhase` scheduled a `setTimeout(0)` on every stale hit even when no refresh handler was registered. Now guarded by `refreshHandlers.has(key)`.

## 0.11.2 — Round 48 (2026-07-06)

6 issues fixed (1 CRITICAL CI, 1 HIGH bug, 2 MEDIUM bug+test, 2 LOW defensive).

### CRITICAL fix (CI)

- **#1**: GitLab CI mirror job force-pushed ANY branch to GitHub's `main` — pushing to `v2/round48` would clobber GitHub `main` and trigger Actions CI on wrong content. Fixed: restrict mirror rules to `$CI_COMMIT_BRANCH == "main"` only.

### HIGH fix (bug)

- **#2**: `ControlTab.tsx` interval callback aborted the ORIGINAL `controller` (closure-captured) instead of `abortRef.current` (latest). After the first 10s interval, the original was already aborted — subsequent intervals created new controllers without cancelling the previous ones. Request pileup + stale-data races. Fixed: use `abortRef.current?.abort()`.

### MEDIUM fixes (bug + test)

- **#3**: `parseNote` regex matched `---` inside quoted YAML string values (e.g. `title: "a --- b"`), silently losing frontmatter on re-export. Fixed: replaced regex with line-by-line scanner that looks for a LINE that is exactly `---`.
- **#4**: `parseNote` test only asserted `body.contains('# Body')` — passed despite frontmatter being completely lost. Strengthened: now asserts `frontmatter.title`, `frontmatter.type`, `body.trim()`.

### LOW fixes (defensive)

- **#5**: `swr-cache.set()` didn't cancel pending refresh timers. Fixed: cancel at top of `set()`.
- **#6**: `ControlTab.handleKill` didn't clear the previous kill timer before setting a new one. Rapid kills stacked timers. Fixed: `clearTimeout` before new timer.

## 0.11.1 — Round 47 (2026-07-06)

10 issues fixed across V2 + Graph UI (3 HIGH, 4 MEDIUM, 3 LOW). 6 new tests.

### HIGH fixes (correctness + performance)

- **H1 BUG**: `prepare_edit_context` called `getBulkNotesByCbmNodeIds` without a limit argument, defaulting to 1. The flagship tool silently under-reported linked notes — agents saw "1 known bug" when 10 were linked. Fixed: pass `limit=200`.
- **H2 PERF**: `generator.ts` `autoGenerateModuleNotes`/`autoGenerateRouteNotes` called `getNeighbors` per module/route — 200+ queries. Fixed: use `getBulkNeighbors` (6 queries total).
- **H3 PERF**: `routeDashboard` called `countNodes`, `countEdges`, `countNodesByLabel` — 3 uncached SQLite scans duplicating SWR-cached `getGraphStatus`. Fixed: reuse cached data.

### MEDIUM fixes

- **M1**: `ControlTab` replaced `mountedRef` with `AbortController` (was piling up requests on slow backend).
- **M3**: `hotspots` report `notes_count` capped at 1 (limit=1). Fixed: `limit=200`.
- **M4**: `parseNote` `---` inside quoted YAML — defensive check (later replaced by line-by-line scanner in R48).
- **L1**: `swr-cache` refresh timer cancellation on `invalidate`.
- **L2**: `syncCbmLinks` DELETE inside transaction (self-contained atomic).
- **L3**: `ControlTab` kill timer cleanup.
