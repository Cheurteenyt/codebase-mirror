# MCP Tools Reference — Codebase Memory V2

> Updated 2026-07-15 for version 0.76.0.

V2 exposes **7 MCP tools** via JSON-RPC 2.0 over stdio. This document describes each tool's input, output, and usage.

## Connection

```json
{
  "mcpServers": {
    "codebase-memory-v2": {
      "command": "node",
      "args": ["/path/to/v2/dist/cli/index.js", "mcp", "--project", "my-app"]
    }
  }
}
```

The server implements:
- JSON-RPC 2.0 protocol (parse error -32700, invalid request -32600, method not found -32601, invalid params -32602, internal error -32603)
- MCP `2025-11-25` by default, with negotiated compatibility for `2025-06-18`
  and `2024-11-05`
- No JSON-RPC batch extension; current MCP revisions removed batching, and
  legacy initialization is always handled as an individual request
- Notification handling (no response for requests without `id`)
- Strict `initialize` / `notifications/initialized` handshake: an early
  `notifications/initialized` notification is ignored, and `tools/call`
  returns JSON-RPC `-32600` until a standalone `initialize` request has been
  negotiated and a subsequent initialized notification has been received
- `ping` keepalive
- `tools/list` and `tools/call` methods
- 10MB max line length (configurable via `MCP_MAX_LINE_LENGTH`)

For MCP 2025 revisions, every listed tool includes the [standard MCP behavioral hints](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations). The five query
tools are marked read-only, idempotent, non-destructive, and closed-world. The
two human-memory writers are marked additive, non-idempotent, non-destructive,
and closed-world. These fields are advisory hints, not an authorization or
trust boundary: clients should only use them to inform tool policy when they
trust this server's definitions. They are omitted when a legacy `2024-11-05`
client negotiates that revision, because the schema did not yet define them.

Tool results use compact JSON without changing the parsed response schema. Run
`npm run bench:tokens -- --project <name>` to compare the actual compact string
with a pretty serialization reconstructed locally from the same parsed value.
The reported reduction is JSON whitespace transport bytes, not measured model
tokens and not a second MCP response mode.

## Tools

### 1. `get_project_overview`

**Purpose**: High-level project stats — first call when an agent starts exploring a codebase.

**Input**: `{ project?: string }`

**Output**:
```json
{
  "project": "my-app",
  "generated_at": "2026-07-05T...",
  "code_graph": {
    "total_nodes": 1542,
    "total_edges": 4200,
    "nodes_by_label": { "Function": 800, "Module": 120 },
    "edges_by_type": { "CALLS": 2000, "IMPORTS": 500 }
  },
  "human_memory": {
    "total_notes": 45,
    "adrs": 12,
    "bugs": 8,
    "active_bugs": 2,
    "refactors": 5,
    "active_refactors": 1,
    "human_edges": 67
  },
  "documentation_coverage": {
    "critical_modules_total": 20,
    "critical_modules_documented": 14,
    "coverage_pct": 70.0,
    "scanned_modules": 120,
    "module_scan_limit": 5000,
    "scan_truncated": false,
    "critical_counts_are_lower_bounds": false,
    "coverage_is_partial": false
  },
  "graph_status": {
    "available": true,
    "freshness_score": 1.0,
    "freshness_label": "FRESH",
    "stale": false,
    "last_indexed": "2026-07-04T10:00:00Z",
    "age_seconds": 3600,
    "stale_files_count": 0,
    "stale_files_sample": [],
    "recommendation": "FRESH"
  },
  "recommendations": [
    "Project is in good shape. Use prepare_edit_context before modifying any file to get full context."
  ]
}
```

`bugs` and `refactors` are historical totals across every status for backwards
compatibility. `active_bugs` and `active_refactors` count only
`status: "active"`; these active counts drive the open-bug and pending-refactor
recommendations.

Module coverage scans at most 5,000 modules. When more exist,
`scan_truncated` and `coverage_is_partial` are `true`, while
`critical_counts_are_lower_bounds` marks the observed critical counts as lower
bounds. `coverage_pct` then describes only the scanned portion and must not be
treated as whole-project coverage.

**Performance**: Uses bulk fetches — `getBulkNodeDegrees` + `getBulkNotesByCbmNodeIds` (1 query for all modules, not N+1). R21: `getBulkNotesByCbmNodeIds` uses the `human_node_cbm_links` junction table with an indexed JOIN instead of `JSON_EACH`.

### 2. `get_module_context`

**Purpose**: Full context of a module, file, class, or interface — code structure + human notes + ADRs + bugs + refactors.

**Input**:
```json
{
  "project": "my-app",
  "module_name": "auth",
  "include_code": true,
  "include_human": true,
  "include_adrs": true,
  "include_bugs": true,
  "include_refactors": true,
  "max_nodes": 200
}
```

**Output**: Module info, code neighbors (up to `max_nodes`), human notes (non-ADR/bug/refactor), ADRs, bugs, refactors, risk score, documentation coverage.

`max_nodes` is an integer bounded to `0..1000`; the response reports the exact
neighbor total, returned count, and whether the list was truncated.

**Resolution and errors**: Resolves `Module`, then `File`, then
`Class`/`Interface`, so native V2 graphs without `Module` nodes work directly.
`module_name` also accepts portable or absolute file paths. Ambiguous matches
return candidate qualified names and paths instead of silently choosing one;
missing matches suggest nearby context roots.

### 3. `get_undocumented_hotspots`

**Purpose**: Find critical code nodes (high degree/complexity) WITHOUT human notes.

**Input**:
```json
{
  "project": "my-app",
  "label": "Module",
  "limit": 50
}
```

`label` is optional — one of `Module`, `Route`, `Function`, `Class`, `Interface`. If omitted, all labels are included.

`limit` is an integer bounded to `0..200`.

**Output**: Coverage stats + list of undocumented critical nodes, sorted by
`degree + complexity` descending, with `total_hotspots`,
`total_hotspots_is_lower_bound`, `returned_hotspots`, and `truncated`
metadata. The underlying report probes up to 5,001 nodes for each of the five
supported labels and analyzes at most 5,000 per label.
`summary.scan_truncated`,
`summary.counts_are_lower_bounds`, `summary.coverage_is_partial`,
`summary.scan_limit_per_label`, and `summary.truncated_labels` describe the
overall scan; every `by_label` entry also reports `scan_truncated` and
`counts_are_lower_bounds`. `total_hotspots_is_lower_bound` applies this
information to the requested label selection. This distinguishes a partial
source scan from a complete scan whose returned hotspot list was merely
shortened by `limit`.

### 4. `create_human_note`

**Purpose**: Create an ADR, BugNote, RefactorPlan, etc. + optionally link to code nodes in a single call.

**R26**: Node creation and edge creation are now wrapped in a single `db.transaction()` — either everything commits or nothing does.

**Input**:
```json
{
  "project": "my-app",
  "label": "ADR",
  "title": "ADR-001: Use JWT",
  "body_markdown": "We chose JWT because...",
  "status": "active",
  "tags": ["security", "auth"],
  "links": [
    { "cbm_node_id": 1234, "edge_type": "DECIDES" }
  ],
  "author": "alice"
}
```

**Validation**:
- `label` must be one of the 11 `HumanNodeLabel` values
- `title` must be non-empty and contain no newlines
- `status` must be one of `draft`, `active`, `reviewed`, `deprecated`
- Each `links[].edge_type` must be one of the 12 `HumanEdgeType` values
- If a code reader is available, each `links[].cbm_node_id` is validated against the code graph

**Output**: Created note ID, slug, obsidian_path, status, cbm_node_ids, tags, created_at, and edge IDs.

### 5. `link_note_to_code_node`

**Purpose**: Link an existing note to a code node (or another human note).

**Input**:
```json
{
  "project": "my-app",
  "human_note_id": 42,
  "target_kind": "code",
  "target_cbm_node_id": 1234,
  "edge_type": "DECIDES",
  "properties": { "reason": "architectural decision" }
}
```

**Validation**:
- Source note must exist and belong to the same project
- For `target_kind: "code"`, the code node is validated (if reader available)
- For `target_kind: "human"`, the target note must exist
- Cross-project edges are rejected

**Output**: Edge ID, source/target IDs, type, created_at.

### 6. `search_code_and_memory`

**Purpose**: Unified search across code graph AND human memory.

**Input**:
```json
{
  "project": "my-app",
  "query": "authentication",
  "limit": 30,
  "search_code": true,
  "search_human": true
}
```

**Behavior**:
- Code search: tries FTS5 (BM25) first, falls back to LIKE on `name` + `qualified_name`
- Human search: LIKE on `title`, `body_markdown`, `tags`, `frontmatter_json`, `author` (excludes `deprecated` notes)
- Results are interleaved (code, human, code, human...) for balanced presentation
- If only one source is enabled, it gets the full limit
- `limit` is an integer bounded to `1..200`, and the applied value is returned
  as `limit_applied`

**Output**: Balanced results with `rank`, `type` (`code` or `human`), and source-specific fields.

### 7. `prepare_edit_context` ⭐ Flagship

**Purpose**: Call this BEFORE editing any source file. Returns everything the agent needs to know: code structure, dependencies, linked human notes, blast radius, risk assessment, conventions, and stale data warnings.

**Input**:
```json
{
  "project": "my-app",
  "file_path": "src/auth/login.ts"
}
```

Or search by symbol name:
```json
{
  "project": "my-app",
  "symbol_name": "login"
}
```

At least one of `file_path` or `symbol_name` is required.

**Output**:
```json
{
  "project": "my-app",
  "file_path": "src/auth/login.ts",
  "found": true,
  "nodes_found": 5,
  "nodes_analyzed": 5,
  "matches_truncated": false,
  "analysis_truncated": false,
  "nodes": [
    {
      "node": { "id": 123, "label": "Function", "name": "login", "file_path": "...", "start_line": 10, "end_line": 50 },
      "dependencies": {
        "relationship_type": "CALLS",
        "calls": [{ "type": "CALLS", "target": "Function:verifyPassword", "target_id": 124 }],
        "called_by": [{ "type": "CALLS", "source": "Route:POST /api/login", "source_id": 200 }],
        "callers_count": 3,
        "callees_count": 5,
        "callers_returned": 3,
        "callees_returned": 5,
        "callers_truncated": false,
        "callees_truncated": false,
        "actual_degree": 8
      },
      "human_notes": {
        "bugs": [{ "id": 1, "title": "Login timeout on slow networks", "status": "active", "body_excerpt": "..." }],
        "adrs": [{ "id": 2, "title": "ADR-003: Use JWT", "status": "active", "body_excerpt": "..." }],
        "refactors": [],
        "conventions": [{ "id": 3, "title": "Always log auth events", "body_excerpt": "..." }],
        "total_notes": 3,
        "notes_returned": 3,
        "truncated": false
      },
      "risk": {
        "score": 0.72,
        "level": "HIGH",
        "complexity": 12,
        "degree": 8,
        "documented": true
      }
    }
  ],
  "blast_radius": {
    "total_dependent_nodes": 12,
    "affected_modules": 3,
    "affected_routes": 1,
    "affected_functions": 8,
    "scope_complete": true
  },
  "human_memory_summary": {
    "open_bugs": 1,
    "active_adrs": 1,
    "pending_refactors": 0,
    "applicable_conventions": 1,
    "returned_counts_are_lower_bounds": false,
    "scope_complete": true
  },
  "risk_assessment": {
    "max_risk_score": 0.72,
    "max_risk_level": "HIGH",
    "highest_risk_node": "login"
  },
  "graph_freshness": {
    "score": 1.0,
    "label": "FRESH",
    "status": { "available": true, "last_indexed": "...", "stale": false, "recommendation": "FRESH" }
  },
  "recommendation": "⚠️ PROCEED WITH CAUTION:\n  - HIGH RISK: login has risk score 0.72. 12 nodes depend on this file.\n  - 1 known bug(s) affect this file. Review before editing: Login timeout on slow networks\n  - 1 convention(s) apply to this file. Respect: Always log auth events"
}
```

**Performance and precision**: Uses bulk fetches — `getBulkNodeDegreesSplit`
(accurate uncapped `CALLS` in/out degree), filtered bulk neighbors,
`getBulkNotesByCbmNodeIds`, and a single `getNodesByIds` for blast radius.
Structural `CONTAINS`/`IMPORTS` edges do not inflate caller/callee counts.
For `File` and `Module` nodes, dependency and blast-radius traversal uses
`IMPORTS`; callable nodes use `CALLS`. The truncation fields distinguish the
50-match search cap, the 20-node analysis cap, the per-node 20-neighbor return
cap, and the linked-note response cap. If analysis scope is partial,
`scope_complete` is false and the tool does not issue a `SAFE TO EDIT` verdict.

**Risk score formula** (R14 fix — dead code not penalized):
```
degreeScore = min(degree / 100, 1.0)
complexityScore = min(complexity / 20, 1.0)
documentationPenalty = (degree > 0 AND notesCount == 0) ? 0.2 : 0
riskScore = min(degreeScore * 0.5 + complexityScore * 0.3 + documentationPenalty, 1.0)
```

## Node Labels (11)

`ArchitectureNote`, `ADR`, `BugNote`, `RefactorPlan`, `LegacyNote`, `Convention`, `Prompt`, `JournalEntry`, `ModuleNote`, `RouteNote`, `RiskNote`

## Edge Types (12)

`EXPLAINS`, `DECIDES`, `AFFECTS`, `TOUCHES`, `DOCUMENTS`, `DEPRECATES`, `REPLACES`, `RISKS`, `MENTIONS`, `JUSTIFIES`, `OWNS`, `TODO_FOR`

## Node Statuses (4)

`draft`, `active`, `reviewed`, `deprecated`

## Node Sources (3)

`human`, `generated`, `mixed`

## Error Handling

Tool handlers catch domain and validation exceptions and return tool results
with `isError: true`, allowing the caller to see the actionable message. The
server reserves JSON-RPC `-32602` for an invalid `tools/call` envelope (for
example, a missing string `params.name`) and `-32603` for an unexpected failure
outside a tool's handled result path.
