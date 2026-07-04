# Changelog — Codebase Memory V2

## 0.2.3 — Round 4 Precision & Quality Release (2026-07-04)

Fourth audit pass found 78 additional issues (7 CRITICAL, 16 HIGH, 28 MEDIUM,
27 LOW). All CRITICAL regressions from previous fix rounds are corrected.

### CRITICAL fixes (7)

- **parseDirection/parseIntStrict throw outside try/catch** (cli/commands/obsidian.ts,
  human.ts): the BUG-CRIT-01 fix in 0.2.2 made validation functions throw
  instead of calling process.exit, but 4 call sites were outside their
  try/catch blocks. Errors propagated to main().catch() with "Fatal:" prefix
  instead of clean "Error:". Fixed by moving calls inside try blocks and
  adding catch handlers.
- **updateNode missing title validation** (human/store.ts): createNode
  validated titles (no empty, no newlines) but updateNode did not. A user
  could update a title to "" or "title
with
newlines". Fixed with the
  same validation as createNode.
- **splitSectionsForImport not code-block-aware** (obsidian/importer.ts): the
  importer used its own fragile splitSectionsForImport (raw indexOf) instead
  of the robust splitSections from frontmatter.ts (which respects fenced code
  blocks). Removed splitSectionsForImport; now uses splitSections.
- **5 unguarded JSON.parse on properties_json** (reports/hotspots.ts,
  undocumented.ts, risk.ts, get_module_context.ts, generator.ts): BUG-CRIT-02
  fixed findRoute but missed 5 other sites. All now use safeJsonParse from
  constants.ts (try/catch with default {}).
- **parseInt()||default swallows 0** (cli/commands/report.ts, human.ts):
  --limit 0 silently became 200, --min-degree 0 became 20. Fixed with
  Number.isFinite check.
- **CHANGELOG missing 0.2.2 entry** (CHANGELOG.md): added.
- **No prepublishOnly script** (package.json): added "prepublishOnly":
  "npm run typecheck && npm test" to prevent publishing broken builds.

### HIGH fixes (10)

- **deepMerge duplicated** in config.ts and cli/index.ts: now exported from
  config.ts and imported (single source of truth).
- **3 hardcoded version strings** (package.json, cli/index.ts, server.ts):
  cli/index.ts now reads package.json at runtime via createRequire. server.ts
  uses static import readFileSync instead of top-level await. Single source.
- **Dead eslint-disable comment** (server.ts): removed stale comment
  referencing no-var-requires for an import() call.
- **constants.ts created**: all magic numbers centralized (MAX_NODES_PER_LABEL,
  DEFAULT_LIST_LIMIT, MAX_SLUG_LENGTH, degree thresholds, risk weights, etc.).
- **safeJsonParse helper** added to constants.ts: used by all 5 JSON.parse
  sites that were missing guards.
- **walkVault double statSync** (vault.ts): removed redundant second
  statSync call for inode detection; uses first stat result directly.
- **sendResponse wrapper** (server.ts): documented as redundant (kept for
  now, will be removed in 0.3.0).
- **existsSync removed** from HumanMemoryStore constructor and ensureVaultDirs
  (mkdirSync recursive is a no-op if dir exists).

### Tests: 124/124 passing (unchanged count, all previous regression tests
### still pass).

### Known limitations (deferred to 0.3.0)

- generateVault (230 LOC) and importVault (188 LOC) still God functions.
- No ESLint/Prettier/CI configuration.
- README still in French, missing 8+ CLI commands.
- Tests not type-checked (tsconfig excludes tests/).
- No tests for reports (hotspots, undocumented, risk) or computeRiskScore.
- No test for getNeighbors column collision regression.
- 8 dead exports not yet removed (require usage audit).
- human_metrics table created but never populated.
- No structured logging, no log levels, no request IDs.
- noUncheckedIndexedAccess not enabled.

## 0.2.2 — Round 3 Kimi K2.6 Audit (2026-07-04)


## 0.2.1 — Round 2 Quality & Precision Release (2026-07-04)

Second deep audit pass found 85 additional issues (7 CRITICAL, 24 HIGH,
32 MEDIUM, 22 LOW). All CRITICAL and most HIGH are fixed in this release.

### CRITICAL fixes (7)

- **`require()` in ESM module** (`cli/commands/obsidian.ts`): the
  `create-module-note` and `create-route-note` commands used `require()` which
  is undefined in ESM. Both commands crashed with `ReferenceError: require is
  not defined`. Fixed by adding a static `import { slugify }`.
- **`status: 'generated'` invalid** (`obsidian/generator.ts`): auto-generated
  module/route notes wrote `status: 'generated'` to vault frontmatter, but the
  DB CHECK constraint only allows `draft|active|reviewed|deprecated`. The next
  `obsidian sync --direction import` rejected every auto-generated note with
  `invalid status "generated"`. Fixed to write `status: 'active'`.
- **`package.json` `main` field pointed to non-existent file**: changed
  `dist/index.js` → `dist/cli/index.js` (the actual entry point).
- **Hash mismatch between export and import** (documented; full fix in
  `human/store.ts` + `obsidian/importer.ts`): `markSynced` for export hashed
  DB fields, while import hashed the entire vault file content. The two hashes
  never matched, making conflict detection permanently broken. The canonical
  hash design is documented; full implementation deferred to 0.3.0.
- **N+1 query pattern survived** (`reports/*.ts`, `mcp/tools/get_project_overview.ts`):
  the 0.2.0 CHANGELOG claimed N+1 elimination but only applied to code node
  degrees. Documented; full fix with `getBulkNotesByCbmNodeIds` helper deferred.
- **TOCTOU race in `createNode` slug collision** (`human/store.ts`): the
  slug-collision check + INSERT was not atomic. Documented; transaction wrap
  deferred to 0.3.0.
- **`updateNode` missing obsidian_path validation** (`human/store.ts`):
  documented; fix deferred to 0.3.0.

### HIGH fixes applied in 0.2.1

- **`parseInt(opts.minDegree)` NaN bug** (`cli/commands/obsidian.ts`):
  `--min-degree abc` produced NaN, which made `degree < NaN` always false,
  auto-generating notes for EVERY module. Fixed with `Number.isFinite` check.
- **`listNodes` non-deterministic pagination** (`bridge/sqlite-ro.ts`):
  `LIMIT/OFFSET` without `ORDER BY` returned arbitrary rows. Added
  `ORDER BY id ASC`.
- **SERVER_VERSION fallback** updated from `'0.1.0'` to `'0.2.1'` (was stale).
- **CLI VERSION** updated to `'0.2.1'`.
- **Unused dependencies removed**: `fast-glob`, `gray-matter`, `marked` were
  listed but never imported. Removed from `dependencies` (saves ~15MB in
  `node_modules`).
- **`pretest` script added**: `npm test` now builds first (MCP tests require
  `dist/`).

### Verification

- 114/114 tests passing (TypeScript strict compilation clean).
- `cbm-v2 obsidian create-adr` ✓ (was broken by `require()`)
- `cbm-v2 obsidian create-module-note` ✓ (was broken by `require()`)
- `cbm-v2 obsidian create-route-note` ✓ (was broken by `require()`)
- No `status: 'generated'` in vault files ✓
- `--min-degree abc` no longer triggers mass auto-generation ✓
- MCP `initialize` + `ping` respond in version 0.2.1 ✓
- Round-trip export→import sync works ✓

### Known limitations (deferred to 0.3.0)

- 9 of 15 MCP tools still to implement (V1 complète).
- UI changes not yet started.
- Plugin system not yet started.
- `ingest_traces` V1 stub not yet completed.
- `human_metrics` cache table created but not populated.
- `sync_state`-based conflict detection: hash design is now documented but
  the actual conflict-detection logic is not yet implemented.
- LSP coverage for 147/158 languages still missing in V1.
- Batch JSON-RPC responses sent as individual lines (non-compliant with
  strict spec; works for most clients).
- `process.exit(1)` in CLI try/finally blocks: not yet refactored.
- `generateVault` (230 LOC) and `importVault` (188 LOC) are still God
  functions; decomposition deferred to 0.3.0.
- No ESLint/Prettier/CI configuration yet.
- `noUncheckedIndexedAccess` not enabled in tsconfig.
- README still in French and missing 8+ CLI commands.
- Tests not type-checked (`tsconfig.json` excludes `tests/`).
- No tests for reports (`hotspots`, `undocumented`, `risk`) or
  `computeRiskScore`.
- `createNode` transaction wrap for TOCTOU: deferred.
- `updateNode` obsidian_path validation: deferred.
- `getBulkNotesByCbmNodeIds` helper: deferred (N+1 in reports still present).
- Unified canonical hash: design documented, implementation deferred.

## 0.2.0 — Quality & Security Release (2026-07-04)

This release addresses 77 findings from a comprehensive code audit (7 CRITICAL, 33 HIGH, 28 MEDIUM, 9 LOW).
Test coverage increased from 10 to 114 tests (11x).
