// v2/src/obsidian/importer.ts
// Import Obsidian vault notes → human memory DB.
// Handles: new notes, updates (with no-op detection), wikilink → edges,
// stale edge cleanup, status/source validation, path-target wikilinks.
//
// R18 refactor: importVault was a 200-line monolith. Split into focused
// sub-functions:
//   - parseVaultFile (parse + validate frontmatter, extract fields)
//   - resolveExistingNode (find existing node by path or slug)
//   - upsertNode (create or update, with no-op detection)
//   - processWikilinks (parse + create edges + cleanup stale)
//   - inferLabelFromFrontmatter / extractTitle (helpers)

import { HumanMemoryStore } from '../human/store.js';
import { CodeGraphReader } from '../bridge/sqlite-ro.js';
import { safeJsonParse } from '../constants.js';
import { parseNote, parseCbmNodeIds, parseTags, splitSections } from './frontmatter.js';
import {
  parseWikilinks,
  classifyWikilinkTarget,
  parseCodeNodeId,
  inferEdgeTypeFromContext,
  Wikilink,
} from './wikilinks.js';
import { walkVault, readNote } from './vault.js';
import {
  slugify,
  HumanNodeLabel,
  HumanNodeStatus,
  HumanNodeSource,
  HUMAN_NODE_STATUSES,
  HUMAN_NODE_SOURCES,
  isHumanNodeLabel,
} from '../human/schema.js';

export interface ImportOptions {
  project: string;
  vaultPath: string;
  humanStore: HumanMemoryStore;
  codeReader?: CodeGraphReader;
  dryRun?: boolean;
}

export interface ImportResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  orphanNotes: string[];
  edgesCreated: number;
  edgesDeleted: number;
  errors: { path: string; error: string }[];
}

/** Placeholder text stripped from HUMAN NOTES before storing in DB. */
const HUMAN_NOTES_PLACEHOLDER = '> ✏️ This section belongs to the user. It will **never** be overwritten by Codebase Memory V2.';

/**
 * Main entry point — iterate all vault files and import each.
 *
 * R36: wrapped the entire import in a single DB transaction. Previously,
 * each file import triggered individual createNode/updateNode/createEdge
 * calls, each in its own implicit transaction. For a vault with 500 files,
 * this meant 500+ transactions — each with WAL overhead, fsync, and
 * journal management. With a single wrapping transaction, all writes are
 * batched into one atomic commit, reducing import time by 10-100x.
 *
 * If any file import throws, the error is recorded but the transaction
 * continues — partial imports are better than no import. The transaction
 * commits at the end with all successful writes.
 */
export function importVault(opts: ImportOptions): ImportResult {
  const result: ImportResult = {
    created: [],
    updated: [],
    unchanged: [],
    orphanNotes: [],
    edgesCreated: 0,
    edgesDeleted: 0,
    errors: [],
  };

  const files = walkVault(opts.vaultPath);

  // R36: wrap all DB writes in a single transaction for performance.
  // The transaction is only opened if we're not in dry-run mode.
  if (opts.dryRun) {
    // Dry-run: no transaction needed, no DB writes.
    for (const relPath of files) {
      if (relPath === '00_Index.md' || relPath.endsWith('ADR-000-template.md')) continue;
      try {
        importSingleFile(relPath, opts, result);
      } catch (e: any) {
        result.errors.push({ path: relPath, error: e.message });
      }
    }
  } else {
    // R36: batch all writes in a single transaction.
    const db = opts.humanStore.getRawDb();
    const tx = db.transaction(() => {
      for (const relPath of files) {
        if (relPath === '00_Index.md' || relPath.endsWith('ADR-000-template.md')) continue;
        try {
          importSingleFile(relPath, opts, result);
        } catch (e: any) {
          result.errors.push({ path: relPath, error: e.message });
        }
      }
    });
    tx();
  }

  return result;
}

/**
 * Import a single vault file: parse, validate, upsert node, process wikilinks.
 */
function importSingleFile(relPath: string, opts: ImportOptions, result: ImportResult): void {
  const content = readNote(opts.vaultPath, relPath);
  if (!content) return;

  // Parse and validate frontmatter.
  const parsed = parseNote(content);
  const fm = parsed.frontmatter;
  const label = inferLabelFromFrontmatter(fm, relPath);
  if (!label) {
    result.errors.push({ path: relPath, error: 'cannot infer label (set frontmatter `type` or move to a known dir)' });
    return;
  }

  const title = extractTitle(parsed.body, relPath) ?? relPath.replace(/\.md$/i, "");
  const slug = slugify(title);
  const cbmNodeIds = parseCbmNodeIds(fm);
  const tags = parseTags(fm);

  // Validate status and source against enums.
  const statusValidation = validateEnum(fm.status as string, HUMAN_NODE_STATUSES, 'status', 'active', relPath);
  if (statusValidation.error) {
    result.errors.push(statusValidation.error);
    return;
  }
  const sourceValidation = validateEnum(fm.source as string, HUMAN_NODE_SOURCES, 'source', 'human', relPath);
  if (sourceValidation.error) {
    result.errors.push(sourceValidation.error);
    return;
  }
  const status = statusValidation.value as HumanNodeStatus;
  const source = sourceValidation.value as HumanNodeSource;

  // Extract HUMAN NOTES section, stripping placeholder text.
  const sections = splitSections(parsed.body);
  const humanBody = sections.humanNotes.split(HUMAN_NOTES_PLACEHOLDER).join('').trim();

  // Find existing node (by obsidian_path first, then slug for orphans only).
  const existing = resolveExistingNode(opts, relPath, slug, result);
  if (existing === 'CONFLICT') return; // error already pushed

  // R26 (Bug #5 fix): removed vestigial vaultHash computation — markSynced()
  // ignores the parameter (prefixed _vaultContentHash). Was wasted SHA-256 on every file.
  const sourceNodeId = upsertNode(existing, opts, result, {
    relPath, label, title, humanBody, fm, status, source, cbmNodeIds, tags,
  });

  if (cbmNodeIds.length === 0) {
    result.orphanNotes.push(relPath);
  }

  // Process wikilinks → edges.
  // R27 (Bug #8 fix): if the node was renamed (existing had a different
  // obsidian_path), also clean up edges from the OLD source_file path.
  const oldObsidianPath = (existing && typeof existing === 'object' && existing.obsidian_path && existing.obsidian_path !== relPath)
    ? existing.obsidian_path
    : null;

  if (sourceNodeId !== null) {
    const edgeCount = processWikilinks(sourceNodeId, humanBody, relPath, opts, result, oldObsidianPath);
    if (edgeCount !== null && !opts.dryRun) {
      result.edgesCreated += edgeCount.created;
      result.edgesDeleted += edgeCount.deleted;
    }
  }
}

/**
 * Validate a frontmatter field against an enum. Returns the validated value
 * or an error message.
 */
function validateEnum(
  rawValue: string | undefined,
  allowed: readonly string[],
  fieldName: string,
  defaultValue: string,
  relPath: string
): { value: string; error?: { path: string; error: string } } {
  const value = rawValue ?? defaultValue;
  if (!(allowed as readonly string[]).includes(value)) {
    return {
      value: defaultValue,
      error: { path: relPath, error: `invalid ${fieldName} "${value}". Valid: ${allowed.join(', ')}` },
    };
  }
  return { value };
}

/**
 * Find an existing human_node for this vault file.
 *
 * R27 (Bug #8 fix): match by obsidian_path first (authoritative), then by
 * slug — EVEN if the matched node has an obsidian_path. This handles the
 * rename scenario: when a user moves a file in Obsidian, the new path
 * doesn't match any existing obsidian_path, but the slug (derived from
 * the title, which hasn't changed) matches the existing node. The importer
 * then updates the node's obsidian_path to the new path.
 *
 * To prevent hijacking a node that belongs to a DIFFERENT file (same slug,
 * different content), we only accept the slug match if the existing node's
 * obsidian_path file no longer exists on disk (confirming the rename).
 *
 * Returns the node, null if no match, or 'CONFLICT' if there's a slug collision.
 */
function resolveExistingNode(
  opts: ImportOptions,
  relPath: string,
  slug: string,
  result: ImportResult
): HumanNode | null | 'CONFLICT' {
  const existingByPath = opts.humanStore.getNodeByObsidianPath(opts.project, relPath);
  let existingBySlug = null;
  if (!existingByPath && slug) {
    const slugMatch = opts.humanStore.getNodeBySlug(opts.project, slug);
    if (slugMatch) {
      if (!slugMatch.obsidian_path) {
        // Orphan node (no vault file) — safe to claim.
        existingBySlug = slugMatch;
      } else if (slugMatch.obsidian_path !== relPath) {
        // R27: The slug matches a node with a DIFFERENT obsidian_path.
        // This is a rename scenario IF the old file no longer exists on disk.
        // Check whether the old path's file is gone.
        const oldContent = readNote(opts.vaultPath, slugMatch.obsidian_path);
        if (oldContent === null) {
          // Old file is gone — this is a rename. Claim the node.
          existingBySlug = slugMatch;
        }
        // If oldContent is not null, the old file still exists — this is
        // a genuine slug collision (two files with the same title). Don't
        // claim the node; a new one will be created with auto-suffixed slug.
      }
    }
  }

  // Detect slug-collision conflict: both exist but differ.
  if (existingByPath && existingBySlug && existingByPath.id !== existingBySlug.id) {
    result.errors.push({
      path: relPath,
      error: `slug collision: path-match node id=${existingByPath.id} and slug-match node id=${existingBySlug.id} are different. Skipping — resolve manually.`,
    });
    return 'CONFLICT';
  }

  return existingByPath ?? existingBySlug;
}

interface UpsertSpec {
  relPath: string;
  label: HumanNodeLabel;
  title: string;
  humanBody: string;
  fm: Record<string, unknown>;
  status: HumanNodeStatus;
  source: HumanNodeSource;
  cbmNodeIds: number[];
  tags: string[];
}

/**
 * Create or update a human_node. Returns the node ID (or null on dry-run/no match).
 * Detects no-ops by comparing key fields.
 */
function upsertNode(
  existing: HumanNode | null,
  opts: ImportOptions,
  result: ImportResult,
  spec: UpsertSpec
): number | null {
  if (existing) {
    // No-op detection: compare key fields.
    const sameContent = existing.body_markdown === spec.humanBody;
    const sameTitle = existing.title === spec.title;
    const sameCbmIds = JSON.stringify(existing.cbm_node_ids.slice().sort()) === JSON.stringify(spec.cbmNodeIds.slice().sort());
    const sameTags = JSON.stringify(existing.tags.slice().sort()) === JSON.stringify(spec.tags.slice().sort());
    const sameStatus = existing.status === spec.status;
    // R26 (Bug #3 fix): compare frontmatter too. Previously, if a user edited
    // only a custom frontmatter key (not title/body/tags/status/cbm_ids), the
    // no-op check would short-circuit and the edit would never reach the DB.
    const existingFm = safeJsonParse(existing.frontmatter_json, {} as Record<string, unknown>);
    const sameFrontmatter = JSON.stringify(sortKeys(existingFm)) === JSON.stringify(sortKeys(spec.fm));
    // R27 (Bug #8 fix): compare obsidian_path too. When a note is renamed,
    // the path changes but the content stays the same. Without this check,
    // the rename would be treated as a no-op and the obsidian_path would
    // never be updated in the DB.
    const samePath = existing.obsidian_path === spec.relPath;
    if (sameContent && sameTitle && sameCbmIds && sameTags && sameStatus && sameFrontmatter && samePath) {
      result.unchanged.push(spec.relPath);
      return existing.id;
    }
    if (!opts.dryRun) {
      opts.humanStore.updateNode(existing.id, {
        title: spec.title,
        body_markdown: spec.humanBody,
        frontmatter: spec.fm,
        status: spec.status,
        source: spec.source,
        cbm_node_ids: spec.cbmNodeIds,
        tags: spec.tags,
        obsidian_path: spec.relPath,
      });
      opts.humanStore.markSynced(existing.id, 'import');
    }
    result.updated.push(spec.relPath);
    return existing.id;
  }

  // Create new node.
  if (!opts.dryRun) {
    const node = opts.humanStore.createNode({
      project: opts.project,
      label: spec.label,
      title: spec.title,
      body_markdown: spec.humanBody,
      frontmatter: spec.fm,
      status: spec.status,
      source: spec.source,
      cbm_node_ids: spec.cbmNodeIds,
      tags: spec.tags,
      obsidian_path: spec.relPath,
      source_file: spec.relPath,
    });
    opts.humanStore.markSynced(node.id, 'import');
    result.created.push(spec.relPath);
    return node.id;
  }
  result.created.push(spec.relPath);
  return null;
}

/**
 * Parse wikilinks from HUMAN NOTES, create edges, and clean up stale edges.
 * Returns {created, deleted} counts, or null if dry-run.
 *
 * R27 (Bug #8 fix): if oldSourceFile is provided (note was renamed),
 * also clean up edges from the OLD source_file path before processing
 * the new one. This prevents orphaned edges from accumulating.
 */
function processWikilinks(
  sourceNodeId: number,
  humanBody: string,
  relPath: string,
  opts: ImportOptions,
  _result: ImportResult,
  oldSourceFile: string | null = null,
): { created: number; deleted: number } | null {
  if (opts.dryRun) return null;

  // R27: clean up edges from the OLD source_file (rename scenario).
  let deleted = 0;
  if (oldSourceFile && oldSourceFile !== relPath) {
    deleted += opts.humanStore.deleteStaleEdgesFromNode(sourceNodeId, oldSourceFile, []);
  }

  const wikilinks = parseWikilinks(humanBody);
  const seenEdgeIds: number[] = [];

  for (const wl of wikilinks) {
    const edgeId = createEdgeFromWikilink(wl, sourceNodeId, humanBody, relPath, opts);
    if (edgeId !== null) {
      seenEdgeIds.push(edgeId);
    }
  }

  // Clean up stale edges that were created from this file but no longer exist.
  deleted += opts.humanStore.deleteStaleEdgesFromNode(sourceNodeId, relPath, seenEdgeIds);
  return { created: seenEdgeIds.length, deleted };
}

/**
 * Create a single edge from a wikilink. Returns the edge ID, or null if the
 * wikilink couldn't be resolved.
 */
function createEdgeFromWikilink(
  wl: Wikilink,
  sourceNodeId: number,
  humanBody: string,
  relPath: string,
  opts: ImportOptions
): number | null {
  const kind = classifyWikilinkTarget(wl.target);

  if (kind === 'code') {
    const cbmId = parseCodeNodeId(wl.target);
    if (cbmId == null) return null;
    const edgeType = inferEdgeTypeFromContext(humanBody, wl);
    const edge = opts.humanStore.createEdge({
      project: opts.project,
      source_human_node_id: sourceNodeId,
      target_kind: 'code',
      target_cbm_node_id: cbmId,
      type: edgeType,
      properties: { alias: wl.alias, inferred: true },
      source_file: relPath,
    });
    return edge.id;
  }

  if (kind === 'human') {
    const targetNode = opts.humanStore.getNodeBySlug(opts.project, wl.target);
    if (!targetNode) return null;
    const edge = opts.humanStore.createEdge({
      project: opts.project,
      source_human_node_id: sourceNodeId,
      target_kind: 'human',
      target_human_node_id: targetNode.id,
      type: 'MENTIONS',
      properties: { alias: wl.alias },
      source_file: relPath,
    });
    return edge.id;
  }

  if (kind === 'path') {
    const targetPath = wl.target.endsWith('.md') ? wl.target : wl.target + '.md';
    const targetNode = opts.humanStore.getNodeByObsidianPath(opts.project, targetPath);
    if (!targetNode) return null;
    const edge = opts.humanStore.createEdge({
      project: opts.project,
      source_human_node_id: sourceNodeId,
      target_kind: 'human',
      target_human_node_id: targetNode.id,
      type: 'MENTIONS',
      properties: { alias: wl.alias, via: 'path' },
      source_file: relPath,
    });
    return edge.id;
  }

  return null;
}

// ── Helpers (unchanged from pre-R18) ───────────────────────────────

function inferLabelFromFrontmatter(
  fm: Record<string, unknown>,
  relPath: string
): HumanNodeLabel | null {
  const type = (fm.type as string)?.toLowerCase();
  if (type) {
    const map: Record<string, HumanNodeLabel> = {
      architecture: 'ArchitectureNote',
      adr: 'ADR',
      bug: 'BugNote',
      refactor: 'RefactorPlan',
      legacy: 'LegacyNote',
      convention: 'Convention',
      prompt: 'Prompt',
      journal: 'JournalEntry',
      module: 'ModuleNote',
      route: 'RouteNote',
      risk: 'RiskNote',
    };
    const label = map[type];
    if (label && isHumanNodeLabel(label)) return label;
  }

  // Infer from path.
  if (relPath.startsWith('ADR/')) return 'ADR';
  if (relPath.startsWith('Bugs/')) return 'BugNote';
  if (relPath.startsWith('Refactor/')) return 'RefactorPlan';
  if (relPath.startsWith('Legacy/')) return 'LegacyNote';
  if (relPath.startsWith('Conventions/')) return 'Convention';
  if (relPath.startsWith('Prompts/')) return 'Prompt';
  if (relPath.startsWith('Journal/')) return 'JournalEntry';
  if (relPath.startsWith('Modules/')) return 'ModuleNote';
  if (relPath.startsWith('Routes/')) return 'RouteNote';
  if (relPath.startsWith('Architecture/')) {
    if (relPath.includes('risk-')) return 'RiskNote';
    return 'ArchitectureNote';
  }
  return null;
}

function extractTitle(body: string, relPath?: string): string | null {
  const match = body.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  // Fallback: use the filename without extension as title.
  if (relPath) {
    const basename = relPath.split(/[\/]/).pop() || relPath;
    return basename.replace(/\.md$/i, '');
  }
  return null;
}

// Import HumanNode type for resolveExistingNode return type.
import type { HumanNode } from '../human/schema.js';

/**
 * R26: Recursively sort object keys for stable JSON comparison.
 * Used by upsertNode's no-op detection to compare frontmatter objects
 * regardless of key order.
 */
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    sorted[key] = (val !== null && typeof val === 'object' && !Array.isArray(val))
      ? sortKeys(val as Record<string, unknown>)
      : val;
  }
  return sorted;
}
