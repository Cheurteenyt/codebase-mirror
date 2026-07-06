# Intelligence Layer — Codebase Memory V2

V2 is not just a storage layer — it's **proactive and graph-aware**. The agent gets context automatically instead of having to ask for everything manually.

## How It Works

### Graph Freshness Detection

V2 knows if the code graph is stale. It uses two signals:

1. **DB file mtime** — the SQLite DB file modification time serves as a proxy for "last indexed" (V1 writes the DB on each index run).
2. **Git log** — `git log --name-only --since="@<unix_ts>"` finds source files changed since the last index.

The freshness score (0.0 to 1.0) is computed from:

| Condition | Score |
|---|---|
| Graph unavailable or empty | 0.0 |
| >50 stale files | 0.2 |
| >10 stale files | 0.4 |
| >0 stale files | 0.6 |
| Age >24h (no stale files) | 0.5 |
| Age >1h (no stale files) | 0.8 |
| Fresh | 1.0 |

Labels: `FRESH` (≥0.9) → `RECENT` (≥0.7) → `STALE` (≥0.5) → `OLD` (≥0.3) → `CRITICAL` (<0.3).

### `prepare_edit_context` — The Flagship Tool

This is the single call that makes the agent "smart" about what it's about to modify.

**Before V2** (agent must manually call 5+ tools):
```
Agent: "I want to edit src/auth/login.ts"
→ grep for functions in the file
→ grep for callers of those functions
→ search for bugs in the repo
→ search for ADRs in the repo
→ check conventions
Total: 5+ calls, ~4600 tokens
```

**With V2** (one call):
```
Agent: prepare_edit_context(file_path="src/auth/login.ts")
→ V2 returns: code nodes, dependencies, bugs, ADRs, refactors,
  conventions, blast radius, risk score, graph freshness, recommendation
Total: 1 call, ~1500 tokens (-67%)
```

### Smart Recommendations

`get_project_overview` now returns actionable recommendations:

```json
{
  "recommendations": [
    "Refresh the code graph: 47 files modified. Run cbm index_repository.",
    "2 open bug(s) — review before making changes.",
    "Documentation coverage is 35% — 8 critical modules undocumented."
  ]
}
```

The agent gets a prioritized action list without having to ask "what should I do?".

## Architecture

```
src/intelligence/
  graph-status.ts    — freshness detection (getGraphStatus, getFreshnessScore, freshnessLabel)
  swr-cache.ts       — Stale-While-Revalidate cache (R37): adaptive TTL, memory-aware eviction, background refresh dedup
  ttl-cache.ts       — simple TTL cache (R36, kept for compat; new code should prefer SwrCache)

src/mcp/tools/
  prepare_edit_context.ts  — flagship tool (context before editing)
  get_project_overview.ts  — enhanced with graph_status + recommendations
```

### Caching (R36–R37)

`getGraphStatus` is the most frequently-called function on the API surface
(every `/api/dashboard` and `/api/stats` call hits it). Two cache layers:

1. **SwrCache** (`swr-cache.ts`) — primary cache. Fresh for `ttlMs` (default
   30s), then stale-but-served for another `staleMs` (default 30s). Stale
   reads return in 0ms and trigger a background refresh via `setTimeout(0)`.
   Adaptive TTL: entries accessed ≥3× get 3× TTL; ≥10× get 10× TTL. Memory-aware
   eviction: when total cached bytes exceed `maxBytes`, least-recently-accessed
   entries are evicted.
2. **`invalidateGraphStatusCache()`** — call this whenever the code graph DB
   changes (re-index, import) so the next read doesn't return a stale entry.

The `countNodesByLabel` helper (R38/R39) also uses a single GROUP BY query
instead of N separate COUNT queries when computing per-label counts.

### Full-text search (R41 + R42)

`HumanMemoryStore.searchHumanNodes(project, query, limit)` uses an FTS5
virtual table (`human_nodes_fts`, migration V4) over `human_nodes`'
searchable columns (title, body_markdown, tags, frontmatter_json, author).
External-content pattern with 3 sync triggers. Tokenizer: `porter unicode61`
(English stemming + accented-char support). Ranking: BM25 via `ORDER BY rank`.

**Query construction (R42):** multi-term queries use AND-of-terms — each
whitespace-separated term is individually double-quoted and joined with
spaces, so FTS5 treats them as an implicit AND. A search for "auth login bug"
matches notes containing all three words anywhere (reordered, scattered
across title/body/tags), not just notes with the literal adjacent phrase.
Single-term queries degenerate to a simple phrase query. Falls back to the
old 5× `LIKE %q%` substring scan if the FTS5 table is missing or the query
syntax trips FTS5's parser. Used by `search_code_and_memory` MCP tool.

## Data Flow

```
Agent calls prepare_edit_context(file_path="src/auth/login.ts")
  ↓
1. Search code graph for nodes matching file_path (up to 20 matches)
  ↓
2. Bulk-fetch degrees (split in/out) for all 20 nodes in ONE query (getBulkNodeDegreesSplit)
   Bulk-fetch human notes for all 20 nodes in ONE query (getBulkNotesByCbmNodeIds)
   Bulk-fetch neighbors for all 20 nodes in 3 queries (getBulkNeighbors — R40 M3)
  ↓
3. Compute risk score (degree × complexity × documentation) per node
  ↓
4. Collect blast radius (unique dependent node IDs from in-neighbors)
  ↓
5. Bulk-fetch blast-radius node labels in ONE query (getNodesByIds)
  ↓
6. Get graph freshness (cached: SWR cache, 30s fresh / 30s stale)
  ↓
7. Build recommendation (warnings → "PROCEED WITH CAUTION" or "SAFE TO EDIT")
  ↓
Return complete context in one response
```

## Future Intelligence Features (Planned)

| Feature | Description | Status |
|---|---|---|
| `cbm-v2 watch` | Daemon: auto-sync Obsidian vault on file change | ✅ Done (0.9.0 / R29) |
| Git hooks | Auto-journal after each commit | Planned |
| Proactive suggestions | V2 suggests creating notes for undocumented modules | Planned |
| Smart-sync | Incremental sync based on mtime (10x faster) | Planned |
| Conflict detection | Read sync_state to detect DB-vs-vault conflicts | Planned |
