// v2/src/human/schema.ts
// Human Memory Graph schema — SQLite DDL and migrations.
// See docs/HUMAN_MEMORY_GRAPH_SCHEMA.md for the full reference.

import type { Database } from 'better-sqlite3';

export const HUMAN_NODE_LABELS = [
  'ArchitectureNote',
  'ADR',
  'BugNote',
  'RefactorPlan',
  'LegacyNote',
  'Convention',
  'Prompt',
  'JournalEntry',
  'ModuleNote',
  'RouteNote',
  'RiskNote',
] as const;

export type HumanNodeLabel = (typeof HUMAN_NODE_LABELS)[number];

export const HUMAN_EDGE_TYPES = [
  'EXPLAINS',
  'DECIDES',
  'AFFECTS',
  'TOUCHES',
  'DOCUMENTS',
  'DEPRECATES',
  'REPLACES',
  'RISKS',
  'MENTIONS',
  'JUSTIFIES',
  'OWNS',
  'TODO_FOR',
] as const;

export type HumanEdgeType = (typeof HUMAN_EDGE_TYPES)[number];

export const HUMAN_NODE_STATUSES = ['draft', 'active', 'reviewed', 'deprecated'] as const;
export type HumanNodeStatus = (typeof HUMAN_NODE_STATUSES)[number];

export const HUMAN_NODE_SOURCES = ['human', 'generated', 'mixed'] as const;
export type HumanNodeSource = (typeof HUMAN_NODE_SOURCES)[number];

export interface HumanNode {
  id: number;
  project: string;
  label: HumanNodeLabel;
  title: string;
  slug: string;
  body_markdown: string;
  frontmatter_json: string;
  status: HumanNodeStatus;
  source: HumanNodeSource;
  obsidian_path: string | null;
  cbm_node_ids: number[];
  tags: string[];
  provenance: string;
  confidence: number;
  source_file: string | null;
  author: string | null;
  created_at: string;
  updated_at: string;
  last_synced_at: string | null;
}

export interface HumanEdge {
  id: number;
  project: string;
  source_human_node_id: number;
  target_kind: 'code' | 'human';
  target_cbm_node_id: number | null;
  target_human_node_id: number | null;
  type: HumanEdgeType;
  properties_json: string;
  provenance: string;
  confidence: number;
  source_file: string | null;
  created_at: string;
}

export interface HumanMetric {
  project: string;
  cbm_node_id: number;
  documentation_coverage: number;
  risk_score: number;
  notes_count: number;
  adrs_count: number;
  bugs_count: number;
  refactors_count: number;
  computed_at: string;
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS human_nodes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project         TEXT NOT NULL,
    label           TEXT NOT NULL CHECK(label IN (
        'ArchitectureNote', 'ADR', 'BugNote', 'RefactorPlan',
        'LegacyNote', 'Convention', 'Prompt', 'JournalEntry',
        'ModuleNote', 'RouteNote', 'RiskNote'
    )),
    title           TEXT NOT NULL,
    slug            TEXT NOT NULL,
    body_markdown   TEXT NOT NULL DEFAULT '',
    frontmatter_json TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('draft', 'active', 'reviewed', 'deprecated')),
    source          TEXT NOT NULL DEFAULT 'human'
                    CHECK(source IN ('human', 'generated', 'mixed')),
    obsidian_path   TEXT,
    cbm_node_ids    TEXT NOT NULL DEFAULT '[]',
    tags            TEXT NOT NULL DEFAULT '[]',
    provenance      TEXT NOT NULL DEFAULT 'human',
    confidence      REAL NOT NULL DEFAULT 1.0
                    CHECK(confidence >= 0.0 AND confidence <= 1.0),
    source_file     TEXT,
    author          TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    last_synced_at  TEXT,
    UNIQUE(project, slug)
);

-- R20: composite indexes replace single-column ones for better query plans.
-- All queries filter by project first, so (project, X) is strictly better than (X).
CREATE INDEX IF NOT EXISTS idx_human_nodes_project_label ON human_nodes(project, label);
CREATE INDEX IF NOT EXISTS idx_human_nodes_project_status ON human_nodes(project, status);
CREATE INDEX IF NOT EXISTS idx_human_nodes_obsidian_path ON human_nodes(obsidian_path);
CREATE INDEX IF NOT EXISTS idx_human_nodes_updated_at ON human_nodes(updated_at);
-- R20: dropped idx_human_nodes_cbm_node_ids — it indexed a JSON TEXT column
-- which JSON_EACH cannot use. It wasted space and slowed down writes.

CREATE TABLE IF NOT EXISTS human_edges (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    project                 TEXT NOT NULL,
    source_human_node_id    INTEGER NOT NULL,
    target_kind             TEXT NOT NULL CHECK(target_kind IN ('code', 'human')),
    target_cbm_node_id      INTEGER,
    target_human_node_id    INTEGER,
    type                    TEXT NOT NULL CHECK(type IN (
        'EXPLAINS', 'DECIDES', 'AFFECTS', 'TOUCHES',
        'DOCUMENTS', 'DEPRECATES', 'REPLACES', 'RISKS',
        'MENTIONS', 'JUSTIFIES', 'OWNS', 'TODO_FOR'
    )),
    properties_json         TEXT NOT NULL DEFAULT '{}',
    provenance              TEXT NOT NULL DEFAULT 'human',
    confidence              REAL NOT NULL DEFAULT 1.0,
    source_file             TEXT,
    created_at              TEXT NOT NULL,
    FOREIGN KEY(source_human_node_id) REFERENCES human_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY(target_human_node_id) REFERENCES human_nodes(id) ON DELETE CASCADE,
    CHECK(
        (target_kind = 'code' AND target_cbm_node_id IS NOT NULL AND target_human_node_id IS NULL)
        OR
        (target_kind = 'human' AND target_human_node_id IS NOT NULL AND target_cbm_node_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_human_edges_project ON human_edges(project);
CREATE INDEX IF NOT EXISTS idx_human_edges_source ON human_edges(source_human_node_id);
CREATE INDEX IF NOT EXISTS idx_human_edges_target_cbm ON human_edges(target_cbm_node_id);
CREATE INDEX IF NOT EXISTS idx_human_edges_target_human ON human_edges(target_human_node_id);
CREATE INDEX IF NOT EXISTS idx_human_edges_type ON human_edges(type);

CREATE TABLE IF NOT EXISTS human_metrics (
    project             TEXT NOT NULL,
    cbm_node_id         INTEGER NOT NULL,
    documentation_coverage REAL NOT NULL,
    risk_score          REAL NOT NULL,
    notes_count         INTEGER NOT NULL DEFAULT 0,
    adrs_count          INTEGER NOT NULL DEFAULT 0,
    bugs_count          INTEGER NOT NULL DEFAULT 0,
    refactors_count     INTEGER NOT NULL DEFAULT 0,
    computed_at         TEXT NOT NULL,
    PRIMARY KEY(project, cbm_node_id)
);

CREATE INDEX IF NOT EXISTS idx_human_metrics_project ON human_metrics(project);
CREATE INDEX IF NOT EXISTS idx_human_metrics_doc ON human_metrics(project, documentation_coverage);
CREATE INDEX IF NOT EXISTS idx_human_metrics_risk ON human_metrics(project, risk_score);

-- sync_state: tracks the last sync hash for each vault file.
CREATE TABLE IF NOT EXISTS sync_state (
    project             TEXT NOT NULL,
    obsidian_path       TEXT NOT NULL,
    last_synced_hash    TEXT NOT NULL,
    last_synced_at      TEXT NOT NULL,
    last_direction      TEXT NOT NULL CHECK(last_direction IN ('export', 'import', 'both')),
    PRIMARY KEY(project, obsidian_path)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TEXT NOT NULL
);
`;

/**
 * R20 Migration V2: optimize indexes for storage + query performance.
 *
 * Changes:
 * 1. Drop the useless idx_human_nodes_cbm_node_ids index (indexed a JSON TEXT
 *    column, unusable by JSON_EACH queries — wasted space + slower writes).
 * 2. Drop single-column idx_human_nodes_label and idx_human_nodes_status
 *    (replaced by composite (project, label) and (project, status) in V1 schema
 *    for new DBs; this migration adds the composites for existing DBs and drops
 *    the old single-column ones).
 * 3. Drop the old idx_human_nodes_project (redundant — the composite indexes
 *    cover project-prefixed queries).
 *
 * These changes are safe: no data is lost, only index structures change.
 * Existing DBs get the same indexes as new DBs after this migration.
 */
const SCHEMA_V2 = `
-- Drop old indexes that are suboptimal or useless.
DROP INDEX IF EXISTS idx_human_nodes_cbm_node_ids;
DROP INDEX IF EXISTS idx_human_nodes_label;
DROP INDEX IF EXISTS idx_human_nodes_status;
DROP INDEX IF EXISTS idx_human_nodes_project;

-- Add composite indexes (IF NOT EXISTS so new DBs that already have them from V1 are unaffected).
CREATE INDEX IF NOT EXISTS idx_human_nodes_project_label ON human_nodes(project, label);
CREATE INDEX IF NOT EXISTS idx_human_nodes_project_status ON human_nodes(project, status);
`;

/**
 * R21 Migration V3: junction table for cbm_node_ids.
 *
 * Creates a normalized junction table `human_node_cbm_links` to replace
 * the JSON_EACH(cbm_node_ids) query pattern. The junction table is the
 * NEW source of truth for code-node ↔ human-node links, while the
 * `cbm_node_ids` TEXT column is kept as a denormalized cache for backward
 * compatibility (export, hash, rendering).
 *
 * Benefits:
 * - Indexed reverse lookup (cbm_node_id → human_nodes) via covering index
 * - Referential integrity via FK CASCADE on delete
 * - No duplicate links (PRIMARY KEY prevents dups)
 * - O(1) add/remove instead of read-modify-write on JSON
 *
 * The backfill populates the junction table from existing cbm_node_ids
 * JSON arrays. If a node has cbm_node_ids = [1, 42, 99], three rows are
 * inserted: (node_id, 1), (node_id, 42), (node_id, 99).
 *
 * After migration, the app keeps both representations in sync:
 * - createNode/updateNode: write junction table + update JSON cache
 * - createEdge (R19): write junction table + update JSON cache
 * - deleteNode: FK CASCADE cleans up junction table automatically
 */
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS human_node_cbm_links (
    human_node_id   INTEGER NOT NULL,
    cbm_node_id     INTEGER NOT NULL,
    PRIMARY KEY (human_node_id, cbm_node_id),
    FOREIGN KEY (human_node_id) REFERENCES human_nodes(id) ON DELETE CASCADE
) WITHOUT ROWID;

-- Covering index for reverse lookups: "which human nodes link to cbm_node_id X?"
CREATE INDEX IF NOT EXISTS idx_cbm_links_cbm_id ON human_node_cbm_links(cbm_node_id);

-- Backfill: populate the junction table from existing cbm_node_ids JSON arrays.
-- JSON_EACH expands the array; we INSERT OR IGNORE to handle potential dups.
INSERT OR IGNORE INTO human_node_cbm_links (human_node_id, cbm_node_id)
SELECT n.id, je.value
FROM human_nodes n, JSON_EACH(n.cbm_node_ids) AS je
WHERE je.value IS NOT NULL AND typeof(je.value) IN ('integer', 'real')
  AND je.value > 0;
`;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial_schema', sql: SCHEMA_V1 },
  { version: 2, name: 'optimize_indexes', sql: SCHEMA_V2 },
  { version: 3, name: 'cbm_links_junction_table', sql: SCHEMA_V3 },
];

export function runMigrations(db: Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r: any) => r.version as number)
  );

  for (const m of MIGRATIONS) {
    if (!applied.has(m.version)) {
      const tx = db.transaction(() => {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString()
        );
      });
      tx();
    }
  }
}

export function isHumanNodeLabel(v: unknown): v is HumanNodeLabel {
  return typeof v === 'string' && (HUMAN_NODE_LABELS as readonly string[]).includes(v);
}

export function isHumanEdgeType(v: unknown): v is HumanEdgeType {
  return typeof v === 'string' && (HUMAN_EDGE_TYPES as readonly string[]).includes(v);
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function obsidianPathFor(label: HumanNodeLabel, slug: string): string {
  switch (label) {
    case 'ArchitectureNote':
      return `Architecture/${slug}.md`;
    case 'ADR':
      return `ADR/${slug}.md`;
    case 'BugNote':
      return `Bugs/${slug}.md`;
    case 'RefactorPlan':
      return `Refactor/${slug}.md`;
    case 'LegacyNote':
      return `Legacy/${slug}.md`;
    case 'Convention':
      return `Conventions/${slug}.md`;
    case 'Prompt':
      return `Prompts/${slug}.md`;
    case 'JournalEntry':
      return `Journal/${slug}.md`;
    case 'ModuleNote':
      return `Modules/${slug.replace(/^module-note-/, '')}.md`;
    case 'RouteNote':
      return `Routes/${slug.replace(/^route-note-/, '')}.md`;
    case 'RiskNote':
      return `Architecture/risk-${slug}.md`;
  }
}
