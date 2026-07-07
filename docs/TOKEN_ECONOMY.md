# Token Economy — How V2 Saves API Tokens

> Updated 2026-07-07 for version 0.13.0.

V2 is designed to **minimize the number of API calls and tokens** an AI agent needs to understand and modify a codebase.

## The Problem

Without V2, an AI agent exploring a codebase must:

1. **Search for code structure** — grep, read files, understand dependencies
2. **Search for human context** — look for ADRs, bug reports, conventions in the repo
3. **Assess risk** — try to figure out what depends on the file being edited
4. **Check for freshness** — guess if the code analysis is up-to-date

Each step requires multiple API calls (grep, read, search), consuming thousands of tokens.

## The V2 Solution

V2 consolidates all these steps into **single MCP tool calls** that return pre-computed, structured data. Internally, V2 uses **bulk queries** to avoid N+1 patterns — a single MCP call may execute only 4 SQL queries even when analyzing 5000 nodes.

## Token Savings by Scenario

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

## Estimated Monthly Savings

Assuming an agent makes 100 edits/month on a mid-size project:

| Metric | Without V2 | With V2 | Monthly Savings |
|---|---|---|---|
| API calls | ~700 | ~100 | -600 calls |
| Tokens consumed | ~560K | ~150K | **-410K tokens** |
| Latency | ~35 min | ~5 min | **-30 min** |

At typical LLM pricing ($0.01/1K tokens), that's **~$4.10/month saved** per developer.

For a team of 10 developers: **~$41/month, ~$492/year**.

## Best Practices for Agents

1. **Always call `prepare_edit_context` before editing** — it's the single most token-efficient call
2. **Call `get_project_overview` first** — it tells you if data is stale and what needs attention
3. **Use `search_code_and_memory` for exploration** — unified search saves a round-trip
4. **Create notes via `create_human_note`** — one call instead of file write + sync + edge creation
5. **Check `graph_status.freshness_label`** — if STALE or worse, recommend re-indexing before trusting the data
6. **Respect the `recommendation` field** — it tells you "SAFE TO EDIT" or "PROCEED WITH CAUTION" with specific warnings
7. **Use `blast_radius` to gauge impact** — if `affected_routes > 0`, your edit could break HTTP endpoints

