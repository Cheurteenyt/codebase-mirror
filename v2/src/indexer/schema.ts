// v2/src/indexer/schema.ts
// R68: SQLite schema for the native TypeScript/JavaScript indexer.
// Compatible with V1's schema — V2's sqlite-ro.ts can read the same DB
// whether it was created by V1 (C, 158 languages) or V2 (TS/JS only).
//
// This is NOT a replacement for V1. V1 supports 158 languages via tree-sitter.
// This module gives V2 partial autonomy for TS/JS projects when the `cbm`
// binary is unavailable.

import type Database from 'better-sqlite3';
import { statSync } from 'node:fs';

/**
 * R126/R131: Current extractor semantics version.
 *
 * Bumped whenever the extractor's semantic output changes in a way that
 * invalidates existing file_hashes. Incremental mode compares the project's
 * stored version to this constant; a mismatch forces a full reindex before
 * any cross-file resolution is published (crossFileCallsStale=true).
 *
 * Version history:
 *   - 0 (implicit default): pre-R126. Treated as "unknown / legacy".
 *   - 1: R126 — `export *` star detection (R125B Bug 57) + terminal
 *        unknown/unresolved resolution (R126 IDX-R125-01/02 + IDX-R126-01/02).
 *        DBs indexed by R122–R125A have valid file_hashes but missing
 *        star_re_export rows, so they must be re-parsed before the new
 *        resolution semantics can be trusted.
 *   - 2: R131 — Module Validity Lock. The extractor no longer deduplicates
 *        `export function foo() {}` + `export { foo }` (IDX-R131-02: ESM
 *        rejects this as Duplicate export). All runtime export occurrences
 *        are preserved so the resolver can detect module-level invalidity.
 *        The resolver also now checks fileInvalidReason (global duplicate
 *        detection, default marker vs binding, star source preflight) before
 *        any name lookup (IDX-R131-01/03/04). DBs indexed by R126–R130 have
 *        deduplicated export rows, so they must be re-parsed.
 *   - 3: R132 — External Star Fix + Default Occurrence Count. The star
 *        source preflight no longer marks modules invalid for bare/external
 *        specifiers (IDX-R132-05: `export * from 'node:path'` is valid ESM).
 *        The extractor now counts all `export default` statements (not just
 *        the first resolvable one), enabling detection of two direct defaults
 *        (IDX-R132-06) and identifier-reference default + binding default
 *        collision (IDX-R132-07). DBs indexed by R131 and earlier have
 *        markers without the count field, so they must be re-parsed.
 *   - 4: R133 — Type/Value Default Lock. The extractor now distinguishes
 *        runtime defaults (function, class, identifier) from type-only
 *        defaults (interface, type alias). `export default interface Shape {}`
 *        is type-only and does NOT count toward the runtime default count,
 *        so it can coexist with `export default function make() {}` (valid
 *        TypeScript). DBs indexed by R132 have inflated counts that include
 *        type-only defaults, so they must be re-parsed.
 *   - 5: R134 — Type Namespace Default Validity + BuiltinModules. The extractor
 *        now persists `export { type Foo as default }` clauses as `type_only_default`
 *        bindings. The resolver checks Node.js builtinModules for bare specifiers.
 *   - 6: R135/R136 — Builtin Truth Lock + top-level `export type { Foo as default }`.
 *        R135 fixed the dead-code builtin check (isBuiltin) and added top-level
 *        type-only default detection. R135 failed to bump the version — R136
 *        corrects this. DBs indexed by R134 (v5) are missing top-level
 *        `type_only_default` rows and may have stale `node:fake` edges.
 *        Both must be re-parsed.
 *   - 7: R141 — Discovery Policy Lock. R139/R140 changed the discovery policy
 *        (external symlinks excluded, directory aliases deduplicated, fail-closed
 *        realpath, canonical paths, deep SKIP_DIRS component check, file-symlink
 *        dedup via dev:ino). R141 also closed the DATA-R141-01 silent graph wipe
 *        (root inaccessible no longer wipes the DB). DBs indexed by R140 and
 *        earlier may contain external-symlink nodes, alias-path file_path rows,
 *        and duplicate File nodes from file symlinks — all of which must be
 *        purged by a full reindex before the new policy is trustworthy. The
 *        version bump forces the incremental gate to mark these DBs stale.
 *   - 8: R144 — Hardlink Language Contract. R143 changed hardlink tie-breaking
 *        from "first seen wins" to "lexicographically smaller path wins". This
 *        can change file_path, qualified names, file_hashes, and potentially
 *        the tree-sitter grammar (module.js vs module.ts). R144 further changes
 *        the identity key to include the language, so two paths with different
 *        extensions to the same inode are treated as separate files (not
 *        deduplicated). DBs indexed by R143 (v7) may have the wrong path/grammar
 *        for hardlinks — they must be re-parsed. The version bump forces the
 *        incremental gate to mark these DBs stale.
 *        R152/R153 NOTE: R152 changed the broken-symlink policy (warnings only,
 *        no globalDeletionUncertainty) and R153 added the alias_history table
 *        for historical-target protection. Neither changes the extractor's AST
 *        output for a stable file, so the semantics version remains 8. A v8 DB
 *        upgraded to R153 code will simply have an empty alias_history until
 *        the next successful run populates it.
 *
 * When bumping this constant, also add a migration test that simulates an
 * upgrade from the previous version (delete the relevant rows, keep
 * file_hashes, run incremental, assert crossFileCallsStale=true).
 */
export const CURRENT_EXTRACTOR_SEMANTICS_VERSION = 8;

/**
 * R154 (MIG-R154-01): Current discovery policy version.
 *
 * SEPARATE from `CURRENT_EXTRACTOR_SEMANTICS_VERSION` (which tracks AST output
 * changes). The discovery policy version tracks changes to:
 *   - broken symlink handling (R152: warning-only, R153: alias_history, R154: cold-start lock)
 *   - alias history schema (R153: initial table, R154: root_fingerprint)
 *   - contribution filter (R154: only contributive aliases historized)
 *   - visibility check (R154: skip protection if target still visible)
 *
 * When bumped, a DB with a lower stored version is treated as "discovery
 * policy not yet initialized" — the indexer applies the cold-start lock
 * (no deletions allowed) until a successful run populates alias_history and
 * sets the version. This closes the R152→R153 cold-start gap: a DB with nodes
 * but no alias_history cannot silently lose data on the first R153+ run.
 *
 * Version history:
 *   - 0 (implicit): pre-R154. Treated as "not initialized". Cold-start lock applies.
 *   - 1: R154 — cold-start lock + root_fingerprint + contribution filter + visibility check.
 *   - 2: R155 — atomic alias state commit + root fingerprint v2 (dev+ino) +
 *     special file type safety + scalable GC + legacy row cleanup.
 *     A DB with policy v1 is treated as "not yet initialized" under v2 — the
 *     cold-start lock applies until a successful v2 run repopulates the
 *     history with the new fingerprint format and stamps rows with the new
 *     run-id scheme.
 */
export const CURRENT_DISCOVERY_POLICY_VERSION = 2;

/**
 * Tables created by the native indexer. Matches V1's schema so that
 * CodeGraphReader (sqlite-ro.ts) can read the DB transparently.
 */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    label TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    properties_json TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    properties_json TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS file_hashes (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    mtime INTEGER NOT NULL,
    mtime_ns TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL,
    UNIQUE(project, file_path)
  );

  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    root_path TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    node_count INTEGER DEFAULT 0,
    edge_count INTEGER DEFAULT 0,
    cross_file_calls_stale INTEGER DEFAULT 0,
    -- R107: explicit flag indicating that a full R106+ reindex has populated
    -- the call_sites table (even if it found 0 call-sites). This distinguishes
    -- a valid R106 DB with 0 call-sites from a legacy pre-R106 DB that never
    -- had call_sites. Without this flag, hasCallSites()===false is ambiguous.
    call_sites_initialized INTEGER DEFAULT 0,
    -- R126: extractor semantics version. Bumped whenever the extractor's
    -- semantic output changes in a way that requires re-parsing existing files.
    -- Incremental mode compares this to CURRENT_EXTRACTOR_SEMANTICS_VERSION;
    -- a mismatch forces a full reindex before any cross-file resolution is
    -- published.
    --   0 = pre-R126 (legacy, never set explicitly)
    --   1 = R126+ (star detection + terminal unknown/unresolved)
    --   2 = R131+ (module validity lock, no export dedup)
    --   3 = R132+ (external star fix, default occurrence count)
    --   4 = R133+ (type/value default lock, interface excluded from runtime count)
    --   5 = R134+ (type namespace default validity, builtinModules check)
    --   6 = R135/R136+ (builtin truth lock, top-level type default, version fix)
    --   7 = R141+ (discovery policy lock: external symlinks, canonical paths,
    --             file-symlink dedup, root discovery failure lock)
    --   8 = R144+ (hardlink language contract: identity includes language,
    --             deterministic tie-break, symlink error classification)
    extractor_semantics_version INTEGER DEFAULT 0,
    -- R144 (STATE-R144-03): Distinguish successful index from failed attempt.
    -- indexed_at is updated by any write (including stale=1 on failure),
    -- which made Graph Status show last_indexed=now after a failed index.
    -- These fields separate the two:
    --   last_successful_index_at — last time a full or incremental index SUCCEEDED
    --   last_index_attempt_at — last time an index was ATTEMPTED (success or failure)
    --   last_index_error — error message from the last failed attempt (NULL on success)
    last_successful_index_at TEXT,
    last_index_attempt_at TEXT,
    last_index_error TEXT,
    -- R154 (MIG-R154-01): alias_history bootstrap state.
    -- 0 = alias_history not yet populated for this project (cold start).
    --     The indexer applies the cold-start lock: no deletions allowed in
    --     incremental mode, full-mode uncertainty lock, until a successful
    --     run populates alias_history and sets this to 1.
    -- 1 = alias_history has been populated by at least one successful R154+ run.
    --     Normal protection applies (only historically-valid broken aliases
    --     protect their old targets).
    -- This closes the R152→R153 cold-start gap: a DB with nodes but no
    -- alias_history cannot silently lose data on the first R153+ run.
    alias_history_initialized INTEGER DEFAULT 0,
    -- R154 (MIG-R154-01): Discovery policy version. Tracks changes to the
    -- broken-symlink / alias-history / contribution / visibility policy.
    -- When the stored version is less than CURRENT_DISCOVERY_POLICY_VERSION,
    -- the indexer treats the alias_history as not-yet-trustworthy and applies
    -- the cold-start lock. After a successful run, the version is upgraded.
    -- Separate from extractor_semantics_version (which tracks AST output
    -- changes and forces a full reindex of file_hashes).
    discovery_policy_version INTEGER DEFAULT 0,
    -- R154 (ALIAS-R154-01): Canonical root fingerprint (realpath + st_dev).
    -- Used to namespace alias_history per physical root. When a project is
    -- reconfigured to a different root (same name, different directory), the
    -- fingerprint mismatch invalidates the alias_history — the new root gets
    -- a fresh history instead of inheriting stale entries from the old root.
    -- NULL on pre-R154 DBs; backfilled on the next successful run.
    root_fingerprint TEXT
  );

  -- R106: Call-sites persistent table.
  -- Stores unresolved call-sites from every file so that cross-file CALLS
  -- edges can be rebuilt in incremental mode (without re-parsing unchanged files).
  -- Schema:
  --   - project + file_path: which file the call-site lives in
  --   - source_qn: qualified name of the enclosing function/method (CALLS source)
  --   - callee: raw callee expression text (e.g. obj.method or foo)
  --   - last_segment: last segment of callee (e.g. method) - used for symbol lookup
  --   - call_kind: identifier_call | member_call | computed_call
  --   - line: 1-indexed source line (for diagnostics)
  -- In incremental mode, only call_sites for changed/deleted files are removed;
  -- call_sites for unchanged files remain and participate in resolution.
  CREATE TABLE IF NOT EXISTS call_sites (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    file_path TEXT NOT NULL,
    source_qn TEXT NOT NULL,
    callee TEXT NOT NULL,
    last_segment TEXT NOT NULL,
    call_kind TEXT NOT NULL,
    line INTEGER NOT NULL
  );

  -- R110: Imports persistent table.
  -- Stores import bindings per file so that cross-file CALLS resolution can
  -- prioritize imported symbols over name-based fallback.
  -- Schema:
  --   - project + file_path: which file the import lives in
  --   - local_name: the name used in the file (after alias, if any)
  --   - source_module: the module path as written (e.g. './b', './utils/helpers')
  --   - imported_name: the original name in the source module (before alias)
  --   - import_kind: named | alias | default | namespace
  --   - line: 1-indexed source line
  -- When resolving a call-site, the resolver checks if the callee name matches
  -- a local_name in the file's imports. If so, it resolves to the source module's
  -- symbol with high confidence (cross_file_import_exact or cross_file_import_alias).
  CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    file_path TEXT NOT NULL,
    local_name TEXT NOT NULL,
    source_module TEXT NOT NULL,
    imported_name TEXT NOT NULL,
    import_kind TEXT NOT NULL,
    line INTEGER NOT NULL
  );

  -- R119: Exports persistent table.
  -- Stores export bindings per file so that the resolver can map exported
  -- names to local symbols (alias) or to re-exported symbols from other files.
  CREATE TABLE IF NOT EXISTS exports (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    file_path TEXT NOT NULL,
    exported_name TEXT NOT NULL,
    local_name TEXT,
    source_module TEXT,
    imported_name TEXT,
    export_kind TEXT NOT NULL,
    line INTEGER NOT NULL
  );

  -- R153 (DATA-R153-01/02): Alias history table.
  -- Persists symlink alias → canonical target mappings observed during
  -- successful discovery runs. When a subsequent run finds the alias broken
  -- (ENOENT or ELOOP on realpath), the indexer looks up the old canonical
  -- target here and protects its data from deletion:
  --   - file target → protected exact path (excluded from deletedRelPaths)
  --   - directory target → protected subtree (prefix match)
  --
  -- This closes the silent historical-target deletion vector introduced by
  -- R152: a previously-valid alias whose target temporarily disappears must
  -- NOT cause the target's nodes/hashes/imports/exports to be deleted.
  --
  -- R154 (ALIAS-R154-01): Added root_fingerprint column. The history is now
  -- namespaced by (project, root_fingerprint, alias_path) so reusing the same
  -- project name with a different root does NOT match stale history from the
  -- old root. The UNIQUE constraint includes root_fingerprint.
  --
  -- R154 (SCHEMA-R154-01): target_kind has a CHECK constraint — only 'file'
  -- and 'directory' are valid. SQLite enforces this at INSERT/UPDATE time.
  --
  -- Schema:
  --   - project + root_fingerprint + alias_path: UNIQUE (one entry per alias per root)
  --   - alias_path: root-relative LEXICAL path of the symlink (e.g. "src/alias.ts")
  --   - canonical_target: root-relative CANONICAL path of the target when valid
  --   - target_kind: 'file' | 'directory' (determines protection scope)
  --   - last_seen_success_at: ISO timestamp of the last run where realpath succeeded
  --   - root_fingerprint: canonical root identity (realpath + st_dev)
  --
  -- The table is NOT cleared by clearProjectData — it must survive full
  -- reindexes to protect future runs. Old entries for removed aliases are
  -- garbage-collected by the indexer after each successful run (R154: run-id GC).
  CREATE TABLE IF NOT EXISTS alias_history (
    id INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    alias_path TEXT NOT NULL,
    canonical_target TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK(target_kind IN ('file', 'directory')),
    last_seen_success_at TEXT NOT NULL,
    root_fingerprint TEXT NOT NULL DEFAULT '',
    last_observed_run_id TEXT,
    UNIQUE(project, root_fingerprint, alias_path)
  );

  -- Indexes matching V1's layout for query compatibility.
  CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project);
  CREATE INDEX IF NOT EXISTS idx_nodes_qn ON nodes(project, qualified_name);
  CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(project, label);
  CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
  CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
  CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
  CREATE INDEX IF NOT EXISTS idx_edges_project ON edges(project);
  CREATE INDEX IF NOT EXISTS idx_file_hashes_path ON file_hashes(project, file_path);
  -- R106: indexes for call_sites — (project, file_path) for per-file delete/replace,
  -- (project, last_segment) is intentionally NOT created because resolution loads
  -- all call_sites for a project at once and uses an in-memory Map (faster than
  -- per-row index lookup for the typical 1k-100k call-site range).
  CREATE INDEX IF NOT EXISTS idx_call_sites_project_file ON call_sites(project, file_path);
  -- R110: index for imports — (project, file_path) for per-file delete/replace.
  CREATE INDEX IF NOT EXISTS idx_imports_project_file ON imports(project, file_path);
  -- R119: index for exports — (project, file_path) for per-file delete/replace.
  CREATE INDEX IF NOT EXISTS idx_exports_project_file ON exports(project, file_path);
  -- R153: index for alias_history — (project) for full-project load,
  -- (project, alias_path) UNIQUE constraint already provides lookup by alias.
  CREATE INDEX IF NOT EXISTS idx_alias_history_project ON alias_history(project);
`;

/**
 * Initialize the SQLite schema for the native indexer.
 * Idempotent — uses CREATE IF NOT EXISTS.
 * R81: also migrates pre-R80 file_hashes tables from UNIQUE(file_path) to
 * UNIQUE(project, file_path) so old DBs don't break with the new ON CONFLICT.
 */
export function initIndexerSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536');
  db.exec(SCHEMA_SQL);
  // R81: Bug 15 — migrate old file_hashes schema if needed
  migrateFileHashesSchema(db);
  // R83: add size column if missing (for mtime+size fast skip)
  migrateFileHashesSizeColumn(db);
  // R85: add mtime_ns column if missing (for nanosecond precision fast skip)
  migrateFileHashesMtimeNsColumn(db);
  // R101: add cross_file_calls_stale column to projects if missing
  migrateProjectsCrossFileStale(db);
  // R107: add call_sites_initialized column to projects if missing
  migrateProjectsCallSitesInitialized(db);
  // R126: add extractor_semantics_version column to projects if missing
  migrateProjectsExtractorSemanticsVersion(db);
  // R144: add last_successful_index_at, last_index_attempt_at, last_index_error
  migrateProjectsIndexStateColumns(db);
  // R153: alias_history table (created by SCHEMA_SQL on fresh DBs; migration
  // function handles legacy DBs that don't have it yet).
  migrateAliasHistoryTable(db);
  // R154: alias_history_initialized, discovery_policy_version, root_fingerprint
  // columns on projects; root_fingerprint + last_observed_run_id on alias_history.
  migrateProjectsR154Columns(db);
  migrateAliasHistoryR154Columns(db);
  // R106: call_sites table is created by SCHEMA_SQL (CREATE IF NOT EXISTS),
  // but the index idx_call_sites_project_file must exist for legacy DBs that
  // already had the table created without it. CREATE INDEX IF NOT EXISTS in
  // SCHEMA_SQL handles this idempotently.
}

/**
 * R81: Bug 15 — Migrate file_hashes from pre-R80 schema (UNIQUE(file_path))
 * to R80+ schema (UNIQUE(project, file_path)). CREATE TABLE IF NOT EXISTS
 * doesn't migrate existing tables, so old DBs keep the old constraint and
 * ON CONFLICT(project, file_path) fails with "does not match any constraint".
 *
 * R82: Bug 23 fix — use PRAGMA index_list/index_info instead of string matching
 * on sqlite_master.sql. More robust against whitespace/case/named-constraint
 * variations. Also cleans up any leftover file_hashes_new from interrupted migration.
 */
function migrateFileHashesSchema(db: Database.Database): void {
  // Clean up any leftover temp table from an interrupted migration
  db.exec('DROP TABLE IF EXISTS file_hashes_new');

  // R82: use PRAGMA to check if a UNIQUE index exists on (project, file_path)
  if (hasUniqueIndexOn(db, 'file_hashes', ['project', 'file_path'])) {
    return; // already has the correct unique constraint
  }

  // Check if table exists at all
  const tableExists = db.prepare(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='file_hashes'"
  ).get() as { c: number };
  if (tableExists.c === 0) return; // CREATE IF NOT EXISTS will make it with correct schema

  // Migrate: create new table, copy data deduped by (project, file_path),
  // drop old, rename, recreate index.
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE file_hashes_new (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        indexed_at TEXT NOT NULL,
        UNIQUE(project, file_path)
      );
    `);
    // Copy with dedup: keep the row with the latest indexed_at per (project, file_path)
    db.exec(`
      INSERT INTO file_hashes_new (project, file_path, content_hash, mtime, indexed_at)
      SELECT project, file_path, content_hash, mtime, indexed_at
      FROM file_hashes
      WHERE id IN (
        SELECT id FROM file_hashes fh1
        WHERE NOT EXISTS (
          SELECT 1 FROM file_hashes fh2
          WHERE fh2.project = fh1.project
            AND fh2.file_path = fh1.file_path
            AND (fh2.indexed_at > fh1.indexed_at OR (fh2.indexed_at = fh1.indexed_at AND fh2.id > fh1.id))
        )
      );
    `);
    db.exec('DROP TABLE file_hashes');
    db.exec('ALTER TABLE file_hashes_new RENAME TO file_hashes');
    db.exec('CREATE INDEX IF NOT EXISTS idx_file_hashes_path ON file_hashes(project, file_path)');
  });
  tx();
}

/**
 * R82: Check if a table has a UNIQUE index on exactly the given columns.
 * Uses PRAGMA index_list + index_info for robust detection.
 */
function hasUniqueIndexOn(db: Database.Database, table: string, columns: string[]): boolean {
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>;
  for (const idx of indexes) {
    if (!idx.unique) continue;
    const cols = db.prepare(`PRAGMA index_info(${idx.name})`).all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    if (colNames.length === columns.length && colNames.every((c, i) => c === columns[i])) {
      return true;
    }
  }
  return false;
}

/**
 * R83: Add `size` column to file_hashes if missing. Enables mtime+size fast
 * skip — if mtime AND size match, skip SHA-256 hashing entirely.
 */
function migrateFileHashesSizeColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(file_hashes)').all() as Array<{ name: string }>;
  const hasSize = cols.some(c => c.name === 'size');
  if (!hasSize) {
    db.exec('ALTER TABLE file_hashes ADD COLUMN size INTEGER NOT NULL DEFAULT 0');
  }
}

/**
 * R85: Add `mtime_ns` column to file_hashes if missing. Enables nanosecond
 * precision fast skip — Math.floor(mtimeMs) can cause false skips when two
 * versions of the same size are written in the same millisecond. mtimeNs
 * (from statSync bigint) gives nanosecond precision, eliminating this risk.
 */
function migrateFileHashesMtimeNsColumn(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(file_hashes)').all() as Array<{ name: string }>;
  const hasMtimeNs = cols.some(c => c.name === 'mtime_ns');
  if (!hasMtimeNs) {
    db.exec('ALTER TABLE file_hashes ADD COLUMN mtime_ns TEXT');
  }
}

/**
 * R101: Add cross_file_calls_stale column to projects if missing.
 */
function migrateProjectsCrossFileStale(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
  const hasCol = cols.some(c => c.name === 'cross_file_calls_stale');
  if (!hasCol) {
    db.exec('ALTER TABLE projects ADD COLUMN cross_file_calls_stale INTEGER DEFAULT 0');
  }
}

/**
 * R107: Add call_sites_initialized column to projects if missing.
 *
 * This flag is set to 1 after any successful full R106+ reindex. It
 * distinguishes:
 *   - A valid R106 DB that found 0 call-sites at full index time (initialized=1)
 *   - A legacy pre-R106 DB that never had call_sites populated (initialized=0)
 *
 * Without this flag, hasCallSites()===false is ambiguous: it returns false
 * for both cases, causing the incremental resolver to skip resolution
 * incorrectly for valid R106 DBs with 0 call-sites (R108 P2 bug).
 */
function migrateProjectsCallSitesInitialized(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
  const hasCol = cols.some(c => c.name === 'call_sites_initialized');
  if (!hasCol) {
    db.exec('ALTER TABLE projects ADD COLUMN call_sites_initialized INTEGER DEFAULT 0');
  }
}

/**
 * R126: Add `extractor_semantics_version` column to projects if missing.
 *
 * Stored as an INTEGER. 0 = legacy / pre-R126 (never set explicitly by
 * R126+ code). After a successful full reindex, the indexer writes
 * CURRENT_EXTRACTOR_SEMANTICS_VERSION. Incremental mode compares the stored
 * value to the current constant; a mismatch forces crossFileCallsStale=true
 * so the caller must run a full reindex before trusting cross-file edges.
 *
 * Why a version column instead of invalidating file_hashes in-place:
 *   - file_hashes may be shared across runs / projects / machines;
 *   - a version column is observable in the DB for diagnostics;
 *   - the cost of a forced full reindex is paid once per semantics bump.
 */
function migrateProjectsExtractorSemanticsVersion(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
  const hasCol = cols.some(c => c.name === 'extractor_semantics_version');
  if (!hasCol) {
    db.exec('ALTER TABLE projects ADD COLUMN extractor_semantics_version INTEGER DEFAULT 0');
  }
}

/**
 * R144 (STATE-R144-03): Add last_successful_index_at, last_index_attempt_at,
 * last_index_error columns to projects if missing. These distinguish a
 * successful index from a failed attempt — `indexed_at` is updated by any
 * write (including stale=1 on failure), which made Graph Status show
 * "last_indexed: now" after a failed index.
 */
function migrateProjectsIndexStateColumns(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
  const names = new Set(cols.map(c => c.name));
  if (!names.has('last_successful_index_at')) {
    db.exec('ALTER TABLE projects ADD COLUMN last_successful_index_at TEXT');
  }
  if (!names.has('last_index_attempt_at')) {
    db.exec('ALTER TABLE projects ADD COLUMN last_index_attempt_at TEXT');
  }
  if (!names.has('last_index_error')) {
    db.exec('ALTER TABLE projects ADD COLUMN last_index_error TEXT');
  }
  // R147 (STATE-R147-01): Idempotent backfill. R146 only ran the backfill
  // when the column was freshly created (`addedLastSuccess`). If the column
  // already existed but was NULL (crash after ALTER, partial migration, R144
  // DB that had a failed first index), no backfill. Now we run it every time
  // — the UPDATE is idempotent (only affects NULL rows).
  //
  // R147 (STATE-R147-02): Stale-aware backfill. `indexed_at` may represent
  // a failed attempt, not a success. Only backfill when the old state was
  // reliable (cross_file_calls_stale=0). If stale=1, leave NULL — we don't
  // know when the last SUCCESSFUL index was.
  db.exec(`
    UPDATE projects
    SET last_successful_index_at = indexed_at
    WHERE last_successful_index_at IS NULL
      AND indexed_at IS NOT NULL
      AND cross_file_calls_stale = 0
  `);
}

/**
 * R153 (DATA-R153-01/02): Create the alias_history table on legacy DBs that
 * pre-date R153. SCHEMA_SQL already creates it on fresh DBs, but CREATE TABLE
 * IF NOT EXISTS is a no-op if the table already exists (e.g., a v8 DB that was
 * opened by R153 code for the first time). The table is required for the
 * indexer's alias-history-based deletion protection.
 *
 * Idempotent — uses CREATE IF NOT EXISTS for both the table and the index.
 */
function migrateAliasHistoryTable(db: Database.Database): void {
  // Check if the table exists. If not, CREATE IF NOT EXISTS in SCHEMA_SQL
  // already handled it. If it exists but is missing the index, add the index.
  // This guard exists for paranoia: a partially-migrated DB might have the
  // table but not the index.
  const tableExists = db.prepare(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='alias_history'"
  ).get() as { c: number };
  if (tableExists.c === 0) {
    // SCHEMA_SQL already ran with CREATE IF NOT EXISTS — if we're here, the
    // table genuinely doesn't exist (fresh DB or migration ran before SCHEMA_SQL).
    // Re-create it explicitly to be safe.
    db.exec(`
      CREATE TABLE IF NOT EXISTS alias_history (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        alias_path TEXT NOT NULL,
        canonical_target TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        last_seen_success_at TEXT NOT NULL,
        UNIQUE(project, alias_path)
      );
    `);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_alias_history_project ON alias_history(project)');
}

/**
 * R154 (MIG-R154-01): Add alias_history_initialized, discovery_policy_version,
 * and root_fingerprint columns to the projects table.
 *
 * Idempotent — uses PRAGMA table_info to detect missing columns.
 *
 * Legacy DBs (pre-R154) get alias_history_initialized=0, discovery_policy_version=0,
 * root_fingerprint=NULL. The indexer's cold-start lock treats these as
 * "not yet initialized" until a successful R154+ run sets them.
 */
function migrateProjectsR154Columns(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
  const names = new Set(cols.map(c => c.name));
  if (!names.has('alias_history_initialized')) {
    db.exec('ALTER TABLE projects ADD COLUMN alias_history_initialized INTEGER DEFAULT 0');
  }
  if (!names.has('discovery_policy_version')) {
    db.exec('ALTER TABLE projects ADD COLUMN discovery_policy_version INTEGER DEFAULT 0');
  }
  if (!names.has('root_fingerprint')) {
    db.exec('ALTER TABLE projects ADD COLUMN root_fingerprint TEXT');
  }
}

/**
 * R154 (ALIAS-R154-01): Add root_fingerprint and last_observed_run_id columns
 * to the alias_history table, and rebuild the UNIQUE constraint to include
 * root_fingerprint.
 *
 * SQLite cannot ALTER a UNIQUE constraint in place. We use a table rebuild:
 *   1. Create alias_history_new with the new schema (including CHECK + root_fingerprint + run_id).
 *   2. Copy existing rows (root_fingerprint defaults to '' for legacy data).
 *   3. Drop old, rename new.
 *   4. Recreate indexes.
 *
 * Idempotent — if the new columns already exist, this is a no-op.
 */
function migrateAliasHistoryR154Columns(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(alias_history)').all() as Array<{ name: string; type?: string }>;
  const names = new Set(cols.map(c => c.name));
  if (names.has('root_fingerprint') && names.has('last_observed_run_id')) {
    // R155: check if last_observed_run_id is TEXT (R155+) or INTEGER (R154).
    // If INTEGER, rebuild to TEXT for UUID support (CONC-R155-01).
    const runIdCol = cols.find(c => c.name === 'last_observed_run_id');
    if (runIdCol && (runIdCol.type ?? '').toUpperCase() === 'INTEGER') {
      // Rebuild to change column type to TEXT.
      db.exec('DROP TABLE IF EXISTS alias_history_new');
      const tx = db.transaction(() => {
        db.exec(`
          CREATE TABLE alias_history_new (
            id INTEGER PRIMARY KEY,
            project TEXT NOT NULL,
            alias_path TEXT NOT NULL,
            canonical_target TEXT NOT NULL,
            target_kind TEXT NOT NULL CHECK(target_kind IN ('file', 'directory')),
            last_seen_success_at TEXT NOT NULL,
            root_fingerprint TEXT NOT NULL DEFAULT '',
            last_observed_run_id TEXT,
            UNIQUE(project, root_fingerprint, alias_path)
          );
        `);
        // Copy existing rows. The INTEGER run_id values are cast to TEXT
        // implicitly by SQLite. Legacy NULL rows stay NULL.
        db.exec(`
          INSERT INTO alias_history_new (id, project, alias_path, canonical_target, target_kind, last_seen_success_at, root_fingerprint, last_observed_run_id)
          SELECT id, project, alias_path, canonical_target, target_kind, last_seen_success_at, root_fingerprint, CAST(last_observed_run_id AS TEXT) FROM alias_history
        `);
        db.exec('DROP TABLE alias_history');
        db.exec('ALTER TABLE alias_history_new RENAME TO alias_history');
        db.exec('CREATE INDEX IF NOT EXISTS idx_alias_history_project ON alias_history(project)');
      });
      tx();
      return;
    }
    // Already migrated to TEXT. Just ensure the index exists.
    db.exec('CREATE INDEX IF NOT EXISTS idx_alias_history_project ON alias_history(project)');
    return;
  }
  // Rebuild the table with the new schema. Existing rows get root_fingerprint=''
  // (legacy) and last_observed_run_id=NULL.
  db.exec('DROP TABLE IF EXISTS alias_history_new');
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE alias_history_new (
        id INTEGER PRIMARY KEY,
        project TEXT NOT NULL,
        alias_path TEXT NOT NULL,
        canonical_target TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK(target_kind IN ('file', 'directory')),
        last_seen_success_at TEXT NOT NULL,
        root_fingerprint TEXT NOT NULL DEFAULT '',
        last_observed_run_id TEXT,
        UNIQUE(project, root_fingerprint, alias_path)
      );
    `);
    // Copy existing rows. Legacy rows (pre-R154) had no root_fingerprint;
    // they get '' which won't match any real R154+ root, so they're
    // effectively isolated from the new policy. They'll be GC'd on the
    // next successful run for the actual root.
    db.exec(`
      INSERT INTO alias_history_new (id, project, alias_path, canonical_target, target_kind, last_seen_success_at, root_fingerprint, last_observed_run_id)
      SELECT id, project, alias_path, canonical_target, target_kind, last_seen_success_at, '', NULL FROM alias_history
    `);
    db.exec('DROP TABLE alias_history');
    db.exec('ALTER TABLE alias_history_new RENAME TO alias_history');
    db.exec('CREATE INDEX IF NOT EXISTS idx_alias_history_project ON alias_history(project)');
  });
  tx();
}

/**
 * R154 (ALIAS-R154-01) + R155 (ROOT-R155-01): Compute a stable fingerprint
 * for a canonical root.
 *
 * The fingerprint combines the realpath (resolved, no symlinks) with the
 * filesystem device ID (st_dev) AND the inode number (st_ino). This ensures:
 *   - Two different directories on the same FS get different fingerprints
 *     (different realpaths).
 *   - The same directory accessed via different mount points gets the same
 *     fingerprint (same realpath, same st_dev, same st_ino).
 *   - A directory that's deleted and recreated at the same path gets a NEW
 *     fingerprint (st_ino changes on most filesystems when the directory is
 *     recreated). R154 only used st_dev, which does NOT change on recreate —
 *     this was ROOT-R155-01. R155 adds st_ino to close the gap.
 *
 * R155 (CONC-R155-01): On filesystems where st_dev/st_ino are both zero
 * (network mounts, FUSE), the fingerprint degrades to just the path. This is
 * weaker but avoids catastrophic collisions. The policy version bump to 2
 * forces a re-population of alias_history under the new fingerprint format.
 *
 * Used to namespace alias_history per physical root. When a project is
 * reconfigured to a different root (same name), the fingerprint mismatch
 * invalidates the old history — the new root starts fresh.
 */
export function computeRootFingerprint(canonicalRoot: string): string {
  try {
    const st = statSync(canonicalRoot, { bigint: true });
    // R155 (ROOT-R155-01): include st_ino so a recreated directory at the
    // same path gets a new fingerprint. Detect untrustworthy dev/ino (both
    // zero — network filesystems) and fall back to path-only.
    if (st.dev === 0n && st.ino === 0n) {
      return `${canonicalRoot}:untrusted`;
    }
    return `${canonicalRoot}:${st.dev.toString()}:${st.ino.toString()}`;
  } catch {
    // If stat fails (extremely unlikely after assertDiscoveryRoot), fall back
    // to just the path. This is weaker but better than crashing.
    return canonicalRoot;
  }
}

/**
 * R153 (DATA-R153-01/02): Load all alias_history entries for a project + root.
 * Returns a Map keyed by alias_path (root-relative lexical) for O(1) lookup.
 *
 * R154 (ALIAS-R154-01): Now scoped by root_fingerprint. Entries from a
 * different root are ignored (they belong to a different physical directory).
 *
 * Used by the indexer after discovery to determine which broken aliases were
 * previously valid. The returned entries drive the protected-paths set that
 * filters deletedRelPaths in incremental mode and forces hasUncertainty in
 * full mode.
 */
export interface AliasHistoryEntry {
  aliasPath: string;
  canonicalTarget: string;
  targetKind: 'file' | 'directory';
  lastSeenSuccessAt: string;
}

export function loadAliasHistory(db: Database.Database, project: string, rootFingerprint: string): Map<string, AliasHistoryEntry> {
  const rows = db.prepare(
    'SELECT alias_path, canonical_target, target_kind, last_seen_success_at FROM alias_history WHERE project = ? AND root_fingerprint = ?'
  ).all(project, rootFingerprint) as Array<{ alias_path: string; canonical_target: string; target_kind: string; last_seen_success_at: string }>;
  const map = new Map<string, AliasHistoryEntry>();
  for (const row of rows) {
    map.set(row.alias_path, {
      aliasPath: row.alias_path,
      canonicalTarget: row.canonical_target,
      targetKind: row.target_kind === 'directory' ? 'directory' : 'file',
      lastSeenSuccessAt: row.last_seen_success_at,
    });
  }
  return map;
}

/**
 * R153 (DATA-R153-01/02): Persist alias_history updates for a project.
 *
 * For each resolved alias (realpath succeeded): UPSERT the entry with the
 * new canonical_target, target_kind, and last_seen_success_at=now. This
 * overwrites any previous entry for the same alias_path.
 *
 * For broken aliases: do NOT touch the existing entry — we want to preserve
 * the last_known canonical_target so future runs can protect it. If the alias
 * was never seen valid, no entry exists; nothing to do.
 *
 * Garbage collection: entries for alias_paths that no longer appear on disk
 * (the symlink was removed) are deleted. The `liveAliasPaths` set contains
 * all alias_paths observed during this discovery (both resolved and broken).
 *
 * R154 (ALIAS-R154-01): Now scoped by root_fingerprint. The fingerprint
 * namespaces the history per physical root.
 *
 * R154 (PERF-R154-01): Replaced the `NOT IN (?, ?, ...)` GC (which built a
 * dynamic SQL string with one parameter per live alias — risk of hitting
 * SQLite's variable limit on heavily-aliased repos) with a run-id GC.
 *
 * R155 (PERF-R155-01): The R154 stamping step still used
 * `alias_path IN (?, ?, ...)` with dynamic params. Replaced with a prepared
 * UPDATE per broken alias, reused via a single prepared statement. No dynamic
 * SQL, no variable limit. O(B) prepared-statement executions where B = broken
 * aliases, each O(log N) via the UNIQUE index.
 *
 * R155 (MIG-R155-01): Legacy rows from the R153→R154 migration have
 * `root_fingerprint=''` and `last_observed_run_id=NULL`. The R154 GC
 * (`last_observed_run_id != runId`) never matched NULL (SQL NULL semantics:
 * `NULL != x` is NULL, not true). R155 GC uses
 * `last_observed_run_id IS NULL OR last_observed_run_id != ?` to also clean
 * legacy NULL rows. Rows with `root_fingerprint=''` (legacy, pre-R154) are
 * cleaned up on the first R155 run via a separate DELETE.
 *
 * R155 (CONC-R155-01): runId is now a string (UUID) instead of Date.now(),
 * eliminating collision risk between concurrent indexers.
 */
export function persistAliasHistory(
  db: Database.Database,
  project: string,
  rootFingerprint: string,
  runId: string,
  resolvedAliases: Array<{ aliasPath: string; canonicalTarget: string; targetKind: 'file' | 'directory' }>,
  liveAliasPaths: Set<string>,
): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    // 1. UPSERT resolved aliases with the current run_id.
    const upsert = db.prepare(`
      INSERT INTO alias_history (project, root_fingerprint, alias_path, canonical_target, target_kind, last_seen_success_at, last_observed_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, root_fingerprint, alias_path) DO UPDATE SET
        canonical_target = excluded.canonical_target,
        target_kind = excluded.target_kind,
        last_seen_success_at = excluded.last_seen_success_at,
        last_observed_run_id = excluded.last_observed_run_id
    `);
    for (const alias of resolvedAliases) {
      upsert.run(project, rootFingerprint, alias.aliasPath, alias.canonicalTarget, alias.targetKind, now, runId);
    }
    // 2. R155 (PERF-R155-01): Stamp broken aliases (still on disk, just broken)
    //    with run_id using a PREPARED UPDATE per alias — no dynamic IN clause.
    //    Each execution is O(log N) via the UNIQUE index. This closes the
    //    variable-limit risk identified in PERF-R155-01.
    const stampStmt = db.prepare(
      'UPDATE alias_history SET last_observed_run_id = ? WHERE project = ? AND root_fingerprint = ? AND alias_path = ?'
    );
    for (const aliasPath of liveAliasPaths) {
      stampStmt.run(runId, project, rootFingerprint, aliasPath);
    }
    // 3. R155 (MIG-R155-01): GC entries not stamped with the current run_id.
    //    Use `IS NULL OR !=` to also catch legacy NULL rows from the R153→R154
    //    migration. Single statement, no dynamic params — O(1) SQL.
    db.prepare(
      'DELETE FROM alias_history WHERE project = ? AND root_fingerprint = ? AND (last_observed_run_id IS NULL OR last_observed_run_id != ?)'
    ).run(project, rootFingerprint, runId);
    // 4. R155 (MIG-R155-01): Clean up legacy rows with root_fingerprint=''
    //    (from the R153→R154 migration). These are never matched by the
    //    scoped GC above. Delete them all for this project.
    db.prepare(
      "DELETE FROM alias_history WHERE project = ? AND root_fingerprint = ''"
    ).run(project);
  });
  tx();
}

/**
 * R155 (TX-R155-01): Atomically commit alias_history + project stats in a
 * SINGLE transaction.
 *
 * R154 called `updateProjectStats` (marks graph fresh, sets
 * alias_history_initialized=1, discovery_policy_version=CURRENT,
 * root_fingerprint) THEN `persistAliasHistory` in separate transactions. If
 * persist failed, the graph was fresh + initialized=1 + policy=CURRENT but
 * the history was empty/stale. The next run's cold-start check read
 * initialized=1 and did NOT fire the lock — the comment "cold-start catches
 * this" was FALSE.
 *
 * R155 closes this by combining BOTH writes in one transaction. If the
 * alias_history persist fails (disk full, SQLite error, corruption), the
 * ENTIRE transaction rolls back:
 *   - projects.cross_file_calls_stale stays 1 (or whatever it was)
 *   - projects.alias_history_initialized stays 0 (or whatever it was)
 *   - projects.discovery_policy_version stays 0 (or whatever it was)
 *   - projects.last_successful_index_at is NOT advanced
 *   - alias_history is NOT modified
 *
 * The next run's cold-start check then correctly detects the uninitialized
 * state and applies the lock.
 *
 * This helper is called ONLY on successful index (crossFileStale=false). On
 * failure paths, the indexer calls `updateProjectStats` alone (with
 * indexError != null, which does NOT set initialized/policy/fingerprint).
 */
export function commitAliasStateAtomically(
  db: Database.Database,
  project: string,
  rootPath: string,
  nodeCount: number,
  edgeCount: number,
  callSitesInitialized: boolean,
  extractorSemanticsVersion: number,
  rootFingerprint: string,
  runId: string,
  resolvedAliases: Array<{ aliasPath: string; canonicalTarget: string; targetKind: 'file' | 'directory' }>,
  liveAliasPaths: Set<string>,
): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    // 1. UPSERT resolved aliases with the current run_id.
    const upsert = db.prepare(`
      INSERT INTO alias_history (project, root_fingerprint, alias_path, canonical_target, target_kind, last_seen_success_at, last_observed_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, root_fingerprint, alias_path) DO UPDATE SET
        canonical_target = excluded.canonical_target,
        target_kind = excluded.target_kind,
        last_seen_success_at = excluded.last_seen_success_at,
        last_observed_run_id = excluded.last_observed_run_id
    `);
    for (const alias of resolvedAliases) {
      upsert.run(project, rootFingerprint, alias.aliasPath, alias.canonicalTarget, alias.targetKind, now, runId);
    }
    // 2. Stamp broken aliases with run_id (prepared UPDATE per alias).
    const stampStmt = db.prepare(
      'UPDATE alias_history SET last_observed_run_id = ? WHERE project = ? AND root_fingerprint = ? AND alias_path = ?'
    );
    for (const aliasPath of liveAliasPaths) {
      stampStmt.run(runId, project, rootFingerprint, aliasPath);
    }
    // 3. GC entries not stamped with the current run_id (IS NULL OR !=).
    db.prepare(
      'DELETE FROM alias_history WHERE project = ? AND root_fingerprint = ? AND (last_observed_run_id IS NULL OR last_observed_run_id != ?)'
    ).run(project, rootFingerprint, runId);
    // 4. Clean up legacy rows with root_fingerprint=''.
    db.prepare(
      "DELETE FROM alias_history WHERE project = ? AND root_fingerprint = ''"
    ).run(project);
    // 5. Update project stats — fresh, initialized, policy current, root fingerprint.
    //    This is in the SAME transaction as the alias_history writes, so if any
    //    of the above failed, this is rolled back too.
    db.prepare(`
      INSERT INTO projects (
        name, root_path, indexed_at, node_count, edge_count,
        cross_file_calls_stale, call_sites_initialized, extractor_semantics_version,
        last_index_attempt_at, last_successful_index_at, last_index_error,
        alias_history_initialized, discovery_policy_version, root_fingerprint
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        root_path = excluded.root_path,
        indexed_at = excluded.indexed_at,
        node_count = excluded.node_count,
        edge_count = excluded.edge_count,
        cross_file_calls_stale = excluded.cross_file_calls_stale,
        call_sites_initialized = excluded.call_sites_initialized,
        extractor_semantics_version = excluded.extractor_semantics_version,
        last_index_attempt_at = excluded.last_index_attempt_at,
        last_successful_index_at = excluded.last_successful_index_at,
        last_index_error = excluded.last_index_error,
        alias_history_initialized = excluded.alias_history_initialized,
        discovery_policy_version = excluded.discovery_policy_version,
        root_fingerprint = excluded.root_fingerprint
    `).run(
      project, rootPath, now, nodeCount, edgeCount,
      0,                                              // crossFileCallsStale = false (success)
      callSitesInitialized ? 1 : 0,
      extractorSemanticsVersion,
      now,                                            // last_index_attempt_at
      now,                                            // last_successful_index_at (success)
      null,                                           // last_index_error (success)
      1,                                              // alias_history_initialized = 1
      CURRENT_DISCOVERY_POLICY_VERSION,               // discovery_policy_version = CURRENT
      rootFingerprint,
    );
  });
  tx();
}

/**
 * Clear all data for a project (nodes, edges, file_hashes, call_sites, imports, exports) before re-indexing.
 * Does NOT clear the projects table — that's updated separately.
 * Does NOT clear alias_history — R153: the alias history must survive full
 *   reindexes to protect future runs from silent historical-target deletion.
 * R106: also clears call_sites (persistent cross-file resolution table).
 * R110: also clears imports (persistent import bindings table).
 * R119: also clears exports (persistent export bindings table).
 */
export function clearProjectData(db: Database.Database, project: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM nodes WHERE project = ?').run(project);
    db.prepare('DELETE FROM edges WHERE project = ?').run(project);
    db.prepare('DELETE FROM file_hashes WHERE project = ?').run(project);
    db.prepare('DELETE FROM call_sites WHERE project = ?').run(project);
    db.prepare('DELETE FROM imports WHERE project = ?').run(project);
    db.prepare('DELETE FROM exports WHERE project = ?').run(project);
  });
  tx();
}

/**
 * Update the projects table with final counts after indexing.
 * R101: also persists cross_file_calls_stale flag.
 * R107: also persists call_sites_initialized flag (set to true after full reindex).
 * R126: also persists extractor_semantics_version (set to CURRENT after full
 *   reindex; preserved by incremental so the gate can detect stale semantics).
 * R144 (STATE-R144-03): also persists last_successful_index_at (on success),
 *   last_index_attempt_at (always), and last_index_error (on failure). This
 *   separates successful index from failed attempt — `indexed_at` is updated
 *   by any write, which made Graph Status show "last_indexed: now" after a
 *   failed index.
 * R154 (MIG-R154-01): also persists alias_history_initialized,
 *   discovery_policy_version, and root_fingerprint. These are only updated on
 *   success (indexError === null) — a failed run does not upgrade the policy
 *   version or mark the history as initialized.
 * R162 (STATE-R162-01): root_path is now preserved on stale/failed runs.
 *   Previously, the ON CONFLICT DO UPDATE clause unconditionally set
 *   `root_path = excluded.root_path`, which meant a stale run (semantics
 *   mismatch, uncertainty, or R162's ROOT_CHANGED/ROOT_IDENTITY_UNKNOWN early
 *   return that uses markProjectStalePreservingGraph + the no-op/deletion-only
 *   stale path) would overwrite the published root_path with the attempted
 *   root. If the attempted root was different from the published root, the
 *   DB would record root_path=B while root_fingerprint=A — a contradiction
 *   that could mislead Graph Status and the next run's root_fingerprint
 *   computation. Now root_path is only updated when last_successful_index_at
 *   is NOT NULL (i.e., the run succeeded). On stale/failed runs, root_path
 *   is preserved (CASE WHEN excluded.last_successful_index_at IS NOT NULL
 *   THEN excluded.root_path ELSE root_path END).
 * R164 (STATE-R164-03): last_index_error is now preserved on stale runs
 *   that pass indexError=null. R163-02 made `succeeded = indexError === null
 *   && !crossFileCallsStale` so a stale run with no error text no longer
 *   advances `last_successful_index_at`. But the UPSERT's
 *   `last_index_error = excluded.last_index_error` still CLEARED the prior
 *   error when indexError=null was passed (the deletion-only path's
 *   "previously stale" no-error scenario). Graph Status, which reads
 *   `last_index_error` for diagnostics, would then show "no error" for a
 *   project that was stale with a prior diagnostic — the diagnostic was
 *   lost. R164 changes the clause to a CASE WHEN: when the run is stale
 *   (excluded.cross_file_calls_stale=1) AND the new error is NULL, preserve
 *   the prior `last_index_error`. Otherwise (success, or stale with a new
 *   error message), use the new value.
 */
export function updateProjectStats(
  db: Database.Database,
  project: string,
  rootPath: string,
  nodeCount: number,
  edgeCount: number,
  crossFileCallsStale: boolean = false,
  callSitesInitialized: boolean = false,
  extractorSemanticsVersion: number = 0,
  indexError: string | null = null,
  aliasHistoryInitialized: boolean | null = null,
  discoveryPolicyVersion: number | null = null,
  rootFingerprint: string | null = null,
): void {
  const now = new Date().toISOString();
  // R163 (STATE-R163-02): Success requires BOTH no error AND not stale.
  // R162 used only `indexError === null`, but `crossFileCallsStale` can be
  // true with `indexError === null` (call-sites uninitialized, previously
  // stale, resolver not published). This would advance
  // `last_successful_index_at` and clear `last_index_error` for a stale run
  // without error text — masking the stale state from Graph Status and
  // downstream consumers that read `last_successful_index_at` to determine
  // freshness. R163 treats `crossFileCallsStale=true` as a non-success even
  // when `indexError` is null.
  const succeeded = indexError === null && !crossFileCallsStale;
  // R144: on success, update last_successful_index_at and clear last_index_error.
  // On failure, set last_index_error but do NOT update last_successful_index_at.
  // R154: on success, also update alias_history_initialized, discovery_policy_version,
  // root_fingerprint. On failure, preserve the old values (don't downgrade).
  db.prepare(`
    INSERT INTO projects (
      name, root_path, indexed_at, node_count, edge_count,
      cross_file_calls_stale, call_sites_initialized, extractor_semantics_version,
      last_index_attempt_at, last_successful_index_at, last_index_error,
      alias_history_initialized, discovery_policy_version, root_fingerprint
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      root_path = CASE WHEN excluded.last_successful_index_at IS NOT NULL THEN excluded.root_path ELSE root_path END,
      indexed_at = excluded.indexed_at,
      node_count = excluded.node_count,
      edge_count = excluded.edge_count,
      cross_file_calls_stale = excluded.cross_file_calls_stale,
      call_sites_initialized = excluded.call_sites_initialized,
      extractor_semantics_version = excluded.extractor_semantics_version,
      last_index_attempt_at = excluded.last_index_attempt_at,
      last_successful_index_at = CASE WHEN excluded.last_successful_index_at IS NOT NULL THEN excluded.last_successful_index_at ELSE last_successful_index_at END,
      last_index_error = CASE
        WHEN excluded.cross_file_calls_stale = 1 AND excluded.last_index_error IS NULL
        THEN last_index_error
        ELSE excluded.last_index_error
      END,
      alias_history_initialized = CASE
        WHEN excluded.alias_history_initialized IS NOT NULL THEN excluded.alias_history_initialized
        ELSE alias_history_initialized
      END,
      discovery_policy_version = CASE
        WHEN excluded.discovery_policy_version IS NOT NULL THEN excluded.discovery_policy_version
        ELSE discovery_policy_version
      END,
      root_fingerprint = CASE
        WHEN excluded.root_fingerprint IS NOT NULL THEN excluded.root_fingerprint
        ELSE root_fingerprint
      END
  `).run(
    project, rootPath, now, nodeCount, edgeCount,
    crossFileCallsStale ? 1 : 0, callSitesInitialized ? 1 : 0, extractorSemanticsVersion,
    now,                                           // last_index_attempt_at
    succeeded ? now : null,                       // last_successful_index_at (only on success)
    indexError,                                    // last_index_error (null on success)
    // R154: only set these on success. Pass null on failure to preserve old values.
    succeeded && aliasHistoryInitialized !== null ? (aliasHistoryInitialized ? 1 : 0) : null,
    succeeded && discoveryPolicyVersion !== null ? discoveryPolicyVersion : null,
    succeeded && rootFingerprint !== null ? rootFingerprint : null,
  );
}
