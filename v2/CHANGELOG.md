# Changelog — Codebase Memory V2

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
