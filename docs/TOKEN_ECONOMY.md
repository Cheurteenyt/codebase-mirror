# Token Economy — Design, Historical Estimates, and Measured Boundaries

> Updated 2026-07-07 for version 0.15.9.
>
> **Historical estimate model:** the -67% to -87% figures below are scenario
> estimates from the v0.15.9-era workflow model, not measurements of the current
> MCP transport or a model tokenizer. The 2026-07-15 compact-vs-pretty benchmark
> is separate and measures only JSON whitespace bytes; see
> [PERFORMANCE_TOKEN_UI_AUDIT_2026-07-15.md](PERFORMANCE_TOKEN_UI_AUDIT_2026-07-15.md).
>
> **Native-agent audit (2026-07-20):** under identical Codex native
> accounting, post-fix V2 MCP-only uses fewer tokens and calls than official
> reproducible V1 in all four target/usage-model aggregates. It still uses
> 1.334x to 1.786x the tokens of optimized grep/read. The exact caller and
> inventory profiles reduce one-shot V2 35.7% on the small target and 43.1% on
> the large target, but continuous-small improves only 5.3%. The cost-aware
> hybrid beats grep/read in two of four post-fix aggregates and makes no MCP
> evidence calls, so it is not evidence of graph-query savings. See
> [V1_V2_TOKEN_TRUTH_AUDIT_2026-07-20.md](V1_V2_TOKEN_TRUTH_AUDIT_2026-07-20.md#15-immutable-post-fix-checkpoint).

V2 is designed to **minimize the number of API calls and tokens** an AI agent needs to understand and modify a codebase.

That sentence states a design objective, not a universal measured advantage.
The executed audit supports a V2-over-V1 result on two pinned repositories, but
does not support an MCP-only advantage over optimized source search.

## The Problem

Without V2, an AI agent exploring a codebase must:

1. **Search for code structure** — grep, read files, understand dependencies
2. **Search for human context** — look for ADRs, bug reports, conventions in the repo
3. **Assess risk** — try to figure out what depends on the file being edited
4. **Check for freshness** — guess if the code analysis is up-to-date

Each step requires multiple API calls (grep, read, search), consuming thousands of tokens.

## The V2 Design

V2 is designed to consolidate graph and human-memory questions into bounded,
structured MCP calls. Internally, it uses bulk queries to avoid N+1 patterns.
Fewer SQL queries do not by themselves prove fewer agent tokens: tool schemas,
payload size, exploration, completeness, and previous-context reprocessing all
contribute to the native total.

## Historical Estimated Token Savings by Scenario

The three scenarios below are preserved as the v0.15.9 design model. They are
not current transport measurements and must not be used as measured savings.

### Scenario 1: Preparing to edit a file

| Step | Without V2 | With V2 |
|---|---|---|
| Find functions in file | grep (~500 tokens) | Included in prepare_edit_context |
| Find callers/callees | grep (~800 tokens) | Included |
| Read the file | read (~2000 tokens) | Not needed (context provided) |
| Find known bugs | grep comments (~500 tokens) | Included |
| Find ADRs | search docs (~500 tokens) | Included |
| Find conventions | search docs (~300 tokens) | Included |
| Assess risk | manual analysis (~1000 tokens) | Included (risk score + recommendation) |
| **Total** | **~5600 tokens, 7 calls** | **~1500 tokens, 1 call** |
| **Savings** | | **-73% tokens, -86% calls** |

### Scenario 2: Project overview

| Step | Without V2 | With V2 |
|---|---|---|
| Count modules/routes | grep + wc (~500 tokens) | Included in get_project_overview |
| Find bugs/ADRs | search (~1000 tokens) | Included |
| Check documentation | manual review (~800 tokens) | Included (coverage %) |
| Check staleness | git log + manual (~500 tokens) | Included (freshness score) |
| **Total** | **~2800 tokens, 4 calls** | **~800 tokens, 1 call** |
| **Savings** | | **-71% tokens, -75% calls** |

### Scenario 3: Finding undocumented hotspots

| Step | Without V2 | With V2 |
|---|---|---|
| List all modules | grep (~500 tokens) | Included in get_undocumented_hotspots |
| Check each for docs | read N files (~2000 tokens) | Included (pre-computed) |
| Prioritize by criticality | manual analysis (~500 tokens) | Included (sorted by degree+complexity) |
| **Total** | **~3000 tokens, 3+ calls** | **~400 tokens, 1 call** |
| **Savings** | | **-87% tokens** |

## How V2 Minimizes Response Size

### Compact excerpts
- `body_excerpt` is capped at 200-500 chars (not full note body)
- Only `title`, `status`, `id` are included for each note (not all fields)

### No duplication
- `human_notes` excludes ADRs/bugs/refactors (they have their own arrays)
- Deduplication by ID across multiple code nodes in the same file
- Balanced search results (code + human interleaved, not concatenated)

### Pre-computed metrics
- Risk score (0.0-1.0) — no need for the agent to calculate
- Documentation coverage % — no need to count manually
- Blast radius count — no need to traverse the graph
- Freshness score — no need to run git commands

### Structured recommendations
- "SAFE TO EDIT" or "PROCEED WITH CAUTION" with specific warnings
- Agent doesn't need to interpret raw data — V2 tells it what to do

## How V2 Minimizes Internal Query Count (N+1 Elimination)

Rounds 13-15 systematically eliminated N+1 query patterns. A single MCP call now executes only a handful of SQL queries, even for large projects:

| MCP Tool / API Path | Before (R12) | After (R15) | Reduction |
|---|---|---|---|
| `get_project_overview` | ~5000 queries (listNodesByCbmNodeId per module) | ~4 queries (1 bulk) | -99.9% |
| `get_module_context` | 1 query (single node — OK) | 1 bulk query (consistent path) | — |
| `prepare_edit_context` | ~100 queries | ~4 queries | -96% |
| `prepare_edit_context` blast radius | 3 getNodesByIds calls | 1 call | -67% |
| `/api/layout` notesCount | ~2000 queries | ~4 queries | -99.8% |
| `/api/layout` edges | ~2000 queries (getNeighbors per node) | ~4 queries (getBulkEdges) | -99.8% |
| `/api/dashboard` critical notes | ~5000 queries | ~1 query | -99.98% |
| `report undocumented` | ~25000 queries | ~25 queries | -99.9% |
| `backup export` edges | ~1000 queries (per note) | 1 query (listAllEdges) | -99.9% |

### SQL-level limit via ROW_NUMBER() (R15)

`getBulkNotesByCbmNodeIds(project, ids, limit)` previously loaded ALL matching rows from SQLite then capped per-node in JavaScript. For a node with 10000 notes and `limit=1`, this loaded all 10000 rows. R15 uses `ROW_NUMBER() OVER (PARTITION BY ...)` to cap at the database level — only `limit` rows per node are transferred. Falls back to the old behavior if window functions are unavailable (SQLite < 3.25, pre-2018).

### Junction table (R21)

R21 replaced the `JSON_EACH(cbm_node_ids)` pattern with a normalized junction table `human_node_cbm_links`. The old pattern scanned every row's JSON array; the new pattern uses an indexed B-tree JOIN for O(log n) reverse lookups. For a project with 5000 modules, `getBulkNotesByCbmNodeIds` went from ~2.5M operations to ~5000 index lookups (-80% to -95%).

## Historical Estimated Monthly Savings

The original v0.15.9 model assumed an agent makes 100 edits/month on a mid-size
project; these values were not remeasured for the current package:

| Metric | Without V2 | With V2 | Monthly Savings |
|---|---|---|---|
| API calls | ~700 | ~100 | -600 calls |
| Tokens consumed | ~560K | ~150K | **-410K tokens** |
| Latency | ~35 min | ~5 min | **-30 min** |

Under the historical model's hypothetical $0.01/1K-token price, that would be
**~$4.10/month saved** per developer. It is not a price or savings measurement
for the current `gpt-5.6-sol` benchmark runtime.

For a team of 10 developers: **~$41/month, ~$492/year**.

## Best Practices for Agents

1. **Route exact literals, known paths, and filesystem inventory to the cheapest exact source operation** when the client permits focused source reads.
2. **Use graph tools for call relationships, blast radius, architecture, and human memory** when the graph can answer directly and completely.
3. **Do not call `get_project_overview` automatically** — call it when project health, freshness, or broad architecture is part of the question.
4. **Use `lookup_source_text` for bounded exact lookups in MCP-only workflows** — batch up to 10 exact strings and inspect its coverage metadata.
5. **Use `prepare_edit_context` when an edit needs blast-radius, risk, or human-memory context**, not as unconditional startup overhead.
6. **Do not duplicate MCP and source evidence** unless completeness is uncertain or verification is necessary.
7. **Use `search_code_and_memory` for exploration** — it combines graph and memory search but does not replace arbitrary source-text search.
8. **Check freshness and completeness fields** before treating an answer as exhaustive; reindex or verify source when coverage is incomplete.

