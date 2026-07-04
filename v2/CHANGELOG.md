# Changelog — Codebase Memory V2

## 0.2.0 — Quality & Security Release (2026-07-04)

This release addresses 77 findings from a comprehensive code audit (7 CRITICAL, 33 HIGH, 28 MEDIUM, 9 LOW).
Test coverage increased from 10 to 114 tests (11x).

### CRITICAL fixes

- **`getNeighbors` column collision** (`bridge/sqlite-ro.ts`): the `SELECT e.*, n.*` query was returning
  corrupted `edge.id` and `edge.properties_json` because both tables share those column names. Fixed
  with explicit column aliases (`e.id AS edge_id`, etc.).
- **Path traversal in vault helpers** (`obsidian/vault.ts`): `readNote`, `writeNote`, `deleteNote` now
  validate that the resolved path stays inside the vault root. `HumanMemoryStore.createNode` and
  `updateNode` reject `obsidian_path` containing `..` or backslashes.
- **`markSynced` import direction**: previously only recorded `sync_state` on export, leaving import
  side permanently stale. Now records state on both directions, with the importer passing the vault
  content hash. Hash now covers `body_markdown + frontmatter_json + cbm_node_ids + tags` (was only
  body_markdown).
- **Slug collision handling** (`human/store.ts`): `createNode` now auto-suffixes slugs with `-2`, `-3`,
  ... up to `-100` on collision (was throwing raw SQLite UNIQUE constraint errors).
- **Empty/non-Latin slug fallback**: `slugify` returning empty string (e.g., for `---` or `日本語`)
  now falls back to `note-<timestamp>` instead of producing `ADR/.md` filenames.
- **Title validation**: rejects empty titles and titles containing newlines (which break Markdown
  headings).

### HIGH fixes

- **MCP protocol compliance** (`mcp/server.ts`):
  - `initialize` now returns `capabilities: { tools: { listChanged: false } }`.
  - Added `ping` method.
  - Added `-32600 Invalid Request` for non-2.0 JSON-RPC, missing method, or non-object payload.
  - Added `-32601 Method not found` with available tools/methods listed in the error message.
  - Added `-32602 Invalid params` for missing required tool args.
  - Added batch request support (array of requests processed sequentially).
  - Added stdin payload size limit (10 MB) to prevent OOM.
  - Added `notifications/cancelled` logging (full abort support is post-MVP).
  - Added `notifications/initialized` enforcement: `tools/call` rejected before initialization.
  - Added SIGTERM/SIGINT graceful shutdown.
  - Server version read from `package.json` (was hardcoded).
- **`create_human_note` and `link_note_to_code_node`** now validate that `target_cbm_node_id` exists
  in the V1 code graph (when a reader is available), preventing orphan edges.
- **Edge dedup**: `createEdge` now returns the existing edge on duplicate creation instead of throwing
  a UNIQUE constraint error. Also added a `deleteStaleEdgesFromNode` helper used by the importer.
- **Cross-project edge rejection**: `createEdge` validates that the source node belongs to the
  specified project.
- **`walkVault`** rewritten as iterative walk with depth limit (32) and symlink loop detection
  (was recursive, prone to stack overflow on deep dirs / symlink loops).
- **`walkVault`** now skips well-known dirs only (`.obsidian`, `.git`, `.trash`, `node_modules`,
  `.cache`) instead of all dotfiles (which skipped legitimate `.attachments/`).
- **`walkVault`** now skips `.bak.*`, `.deleted.*`, `.conflict.*` files (was picking them up).
- **Backup rotation**: `writeNote` now keeps at most 5 backups per file (was unbounded).
- **`ADR_TEMPLATE` frozen date**: refactored to `getAdrTemplate()` function (was a module-load-time
  constant, freezing the date for long-running processes).
- **`frontmatter.splitSections`**: now correctly handles reversed section order (HUMAN NOTES before
  AUTO-GENERATED) by treating it as malformed and preserving everything as human notes.
- **`frontmatter.splitSections`**: now respects fenced code blocks (```) — headings inside code
  blocks no longer trigger section splitting.
- **`frontmatter.parseNote`**: now catches YAML parse errors and returns empty frontmatter (was
  throwing, crashing all reads on malformed notes).
- **`frontmatter.parseTags`**: now lowercases tags (was inconsistent between array and string forms).
- **`wikilinks.inferEdgeTypeFromContext`**: fixed duplicate `'explication'` check (was `explication
  || explication`, now `explication || explique || explications || contexte`).
- **`wikilinks.parseWikilinks`**: tightened regex to exclude `[` from target (was matching `[[[a]]`
  with target `[a`).
- **`wikilinks.inferEdgeTypeFromContext`**: O(n²) → O(n) via single regex scan.
- **`bridge/sqlite-ro.ts`**: removed `journal_mode = WAL` on readonly connection (was a no-op or
  error).
- **`bridge/sqlite-ro.ts`**: added `busy_timeout = 5000` for concurrent access.
- **`bridge/sqlite-ro.ts`**: `findRoute` now uses `json_extract` (SQLite 3.38+) for indexed-style
  lookup; fallback scans up to 10000 routes (was 500, missing routes beyond).
- **`bridge/sqlite-ro.ts`**: `searchCode` FTS5 query wrapped in double quotes for phrase queries
  (was passing raw user input, breaking on FTS5 syntax like `AND`).
- **`bridge/sqlite-ro.ts`**: `searchCode` LIKE fallback now escapes backslash correctly.
- **`bridge/sqlite-ro.ts`**: `searchCode` FTS5 now trusts empty results (was falling through to LIKE
  on 0 results, producing inconsistent behavior).
- **`bridge/sqlite-ro.ts`**: `listProjects` now falls back to `SELECT DISTINCT project FROM nodes`
  if the `projects` table doesn't exist.
- **`bridge/sqlite-ro.ts`**: added `getBulkNodeDegrees(ids)` and `getNodesByIds(ids)` helpers to
  eliminate N+1 query patterns in reports and tools.
- **`human/store.ts`**: added `busy_timeout = 5000` for concurrent CLI/MCP access.
- **`human/store.ts`**: `deserializeNode` now uses `safeJsonParseArray` (try/catch around JSON.parse)
  to prevent one corrupt row from crashing the entire MCP server.
- **`human/store.ts`**: `openMemory` now sets `busy_timeout` for consistency with the file-backed
  constructor.
- **`human/store.ts`**: error messages now include valid labels/types and offending values (was
  `"Invalid human node label: X"` with no hint of valid values).
- **`obsidian/importer.ts`**: added no-op detection (notes unchanged on both sides are pushed to
  `unchanged` instead of `updated`).
- **`obsidian/importer.ts`**: now deletes stale edges (wikilinks removed from a note since last import).
- **`obsidian/importer.ts`**: added slug-collision detection (path-match and slug-match pointing to
  different nodes → error instead of silent data corruption).
- **`obsidian/importer.ts`**: validates `status` and `source` from frontmatter against enums.
- **`obsidian/importer.ts`**: resolves path-style wikilinks (`[[Modules/auth]]`) to human nodes.
- **`obsidian/generator.ts`**: uses cursor-based pagination (500 nodes/page) instead of loading all
  nodes into memory (was `limit: 10000`).
- **`obsidian/generator.ts`**: uses `slugify()` consistently (was using inline regex for module/route
  slugs, producing different slugs than `createNode`).
- **`obsidian/generator.ts`**: uses `countNodesByLabel` for accurate `00_Index.md` stats (was using
  `listModules().length` capped at 200).
- **`obsidian/generator.ts`**: bulk-fetches code nodes via `getNodesByIds` (was N+1 per cbm_node_id).
- **`obsidian/generator.ts`**: bulk-fetches module degrees via `getBulkNodeDegrees` (was N+1).
- **`obsidian/generator.ts`**: calls `markSynced` for auto-generated module/route notes (was leaving
  `last_synced_at` null forever).
- **`obsidian/generator.ts`**: rolls back DB node creation if file write fails (was leaving orphan
  DB rows).
- **`reports/risk.ts`**: `total_items` now reports the true total found (was capped to `limit`).
  Added `total_items_returned` for the sliced count.
- **`reports/risk.ts`**: extracted `computeRiskScore(degree, complexity, notesCount)` shared function
  (was duplicated in `hotspots.ts` and `get_module_context.ts`).
- **`reports/hotspots.ts`**: uses bulk degree fetch and `countNodesByLabel` for accurate totals.
- **`reports/undocumented.ts`**: uses bulk degree fetch.
- **`mcp/tools/base.ts`**: `optionalNumber` now returns `undefined` for non-numeric values (was
  returning `NaN`, which SQLite stored as NULL, triggering CHECK constraint failures).
- **`mcp/tools/base.ts`**: added `requireNumber` and `requireEnum` helpers.
- **`mcp/tools/base.ts`**: error messages now include the offending value and type.
- **`mcp/tools/search_code_and_memory.ts`**: results now balanced between code and human (was
  code-first, hiding human results when code was plentiful). Also searches `frontmatter_json` and
  `author` (was only title/body/tags).
- **`mcp/tools/get_module_context.ts`**: `truncated` now accurate (fetches `maxNodes + 1`). Removed
  redundant `listNodesByCbmNodeId` call. Removed unused `depth` argument. Uses shared
  `computeRiskScore`. Suggests similar modules when no match found.
- **`mcp/tools/get_project_overview.ts`**: `coverage_pct` returns `null` when there are no critical
  modules (was misleadingly returning 100%).
- **`mcp/tools/get_undocumented_hotspots.ts`**: improved error message.

### MEDIUM fixes

- **`.codebase-memory.json` loader** (`config.ts`): new module that loads the config file with deep-
  merge against defaults. All CLI commands now use it for `--vault`, `--min-degree`,
  `backupBeforeWrite`, etc. (was written by `cbm-v2 init` but never read).
- **`cbm-v2 doctor`** command: runs 5 diagnostics (Node version, config file, human DB, code graph
  DB, vault path writability).
- **`cbm-v2 -V`** short flag for `--version`.
- **CLI `--direction` enum validation**: rejects invalid values with clear error (was silently doing
  nothing).
- **CLI error messages**: include valid options for `--type`, `--status`, `--edge` (was cryptic
  SQLite CHECK errors).
- **CLI `deriveProjectName`**: uses `path.basename()` (was `cwd().split(/[\\/]/).pop()` which failed
  on trailing slash).
- **CLI `obsidian report`**: `--format json` now produces JSON output (was Markdown regardless).
- **CLI `human link`**: verifies note exists and belongs to project before creating edge.
- **CLI `human show`**: validates ID is numeric.
- **CLI `obsidian create-adr`**: validates `--status` enum.
- **`human/store.ts`**: `updateNode` no longer changes slug on title change (was breaking wikilinks).
- **`human/store.ts`**: `deleteStaleEdgesFromNode` helper for importer.
- **All reports**: escape pipe characters in Markdown tables (was breaking tables on names with `|`).
- **Reports**: French → English (consistent with code/UI strings).

### LOW fixes

- **`slugify`**: removed unreachable `/-{2,}/g` regex (dead code).
- **`mergeSections`**: placeholder text switched from French to English.
- **`renderVaultIndex` / `getAdrTemplate`**: French → English.
- **`human_metrics` table**: kept in schema (post-MVP cache), but documented as not-yet-populated.
- **`obsidianPathFor`**: documented dead-code path for `ModuleNote`/`RouteNote` slug stripping.

### Tests added (114 total, up from 10)

- `tests/obsidian/frontmatter.test.ts` (20 tests): parseNote, splitSections (including reversed
  order and code blocks), mergeSections roundtrip, parseCbmNodeIds, parseTags, buildFrontmatter.
- `tests/obsidian/wikilinks.test.ts` (15 tests): parseWikilinks, classifyWikilinkTarget,
  parseCodeNodeId, inferEdgeTypeFromContext (each heading variant).
- `tests/obsidian/vault.test.ts` (13 tests): ensureVaultDirs, readNote/writeNote, path traversal
  rejection, backup rotation (cap at 5), walkVault (empty, recursive, .obsidian skip, .git skip,
  .bak skip, .deleted skip, symlink loop).
- `tests/obsidian/sync-conflict.test.ts` (5 tests): HUMAN NOTES preserved across DB body changes,
  vault HUMAN NOTES imported back, no-op detection, stale edge cleanup, empty vault handling.
- `tests/human/store-additional.test.ts` (20 tests): slug collision (auto-suffix), empty title
  rejection, newline title rejection, non-Latin fallback, long title truncation, obsidian_path
  validation, edge dedup, cross-project edge rejection, JSON corruption resilience, markSynced,
  deleteStaleEdgesFromNode, error message quality.
- `tests/mcp/server.test.ts` (11 tests): initialize shape, ping, tools/list (6 tools), -32601
  method not found, -32601 with available tools, -32600 invalid request, batch requests,
  notifications (no response), create_human_note happy path, create_human_note invalid label,
  search_code_and_memory.
- `tests/config.test.ts` (7 tests): deriveProjectName (basename, root, trailing slash), loadConfig
  (defaults, file load, deep-merge, malformed JSON fallback).

### Documentation

- Added `v2/CHANGELOG.md` (this file).
- Updated `v2/README.md` to reflect new `doctor` command and `-V` flag.
- Code comments added for all critical fix sites explaining the why.

### Breaking changes

- `markSynced(id, direction)` → `markSynced(id, direction, vaultContentHash?)`. The third arg is
  optional but recommended for import direction.
- `walkVault` now skips `.bak.*`, `.deleted.*`, `.conflict.*` files. If you relied on importing
  these, rename them.
- `human/store.ts` `createNode` now throws on empty/newline titles (was silently producing broken
  files).
- `search_code_and_memory` result shape: `total_matches`, `code_matches`, `human_matches` (was just
  `total_matches`).

### Known limitations (post-MVP, tracked for V1 complète)

- 9 of 15 MCP tools still to implement (see `docs/V2_ROADMAP.md`).
- UI changes not yet started.
- Plugin system not yet started.
- `ingest_traces` V1 stub not yet completed.
- `human_metrics` cache table created but not populated (reports compute on-the-fly).
- `sync_state`-based conflict detection (`.conflict` backup files) not yet implemented — last
  writer wins silently.
- LSP coverage for 147/158 languages still missing in V1.

## 0.1.0 — MVP (2026-07-04)

Initial MVP release. See commit history for details.
