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
import { parseNote, parseCbmNodeIds, parseTags, splitSections } from './frontmatter.js';
import {
  parseWikilinks,
  classifyWikilinkTarget,
  parseCodeNodeId,
  inferEdgeTypeFromContext,
  Wikilink,
} from './wikilinks.js';
import { walkVault, readNote, hashContent } from './vault.js';
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
  for (const relPath of files) {
    // Skip generated files.
    if (relPath === '00_Index.md' || relPath.endsWith('ADR-000-template.md')) continue;
    try {
      importSingleFile(relPath, opts, result);
    } catch (e: any) {
      result.errors.push({ path: relPath, error: e.message });
    }
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

  const vaultHash = hashContent(content);

  // Upsert the node (create or update, with no-op detection).
  const sourceNodeId = upsertNode(existing, opts, result, {
    relPath, label, title, humanBody, fm, status, source, cbmNodeIds, tags, vaultHash,
  });

  if (cbmNodeIds.length === 0) {
    result.orphanNotes.push(relPath);
  }

  // Process wikilinks → edges.
  if (sourceNodeId !== null) {
    const edgeCount = processWikilinks(sourceNodeId, humanBody, relPath, opts, result);
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
 * Match by obsidian_path first (authoritative). Fall back to slug ONLY if
 * the matched node has no obsidian_path (orphan node created programmatically).
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
    // Only use slug match if the matched node has no obsidian_path (orphan).
    if (slugMatch && !slugMatch.obsidian_path) {
      existingBySlug = slugMatch;
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
  vaultHash: string;
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
    if (sameContent && sameTitle && sameCbmIds && sameTags && sameStatus) {
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
      opts.humanStore.markSynced(existing.id, 'import', spec.vaultHash);
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
    opts.humanStore.markSynced(node.id, 'import', spec.vaultHash);
    result.created.push(spec.relPath);
    return node.id;
  }
  result.created.push(spec.relPath);
  return null;
}

/**
 * Parse wikilinks from HUMAN NOTES, create edges, and clean up stale edges.
 * Returns {created, deleted} counts, or null if dry-run.
 */
function processWikilinks(
  sourceNodeId: number,
  humanBody: string,
  relPath: string,
  opts: ImportOptions,
  _result: ImportResult
): { created: number; deleted: number } | null {
  if (opts.dryRun) return null;

  const wikilinks = parseWikilinks(humanBody);
  const seenEdgeIds: number[] = [];

  for (const wl of wikilinks) {
    const edgeId = createEdgeFromWikilink(wl, sourceNodeId, humanBody, relPath, opts);
    if (edgeId !== null) {
      seenEdgeIds.push(edgeId);
    }
  }

  // Clean up stale edges that were created from this file but no longer exist.
  const deleted = opts.humanStore.deleteStaleEdgesFromNode(sourceNodeId, relPath, seenEdgeIds);
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
