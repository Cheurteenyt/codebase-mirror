// v2/src/obsidian/importer.ts
// Import Obsidian vault notes → human memory DB.
// Handles: new notes, updates (with no-op detection), wikilink → edges,
// stale edge cleanup, status/source validation, path-target wikilinks.

import { HumanMemoryStore } from '../human/store.js';
import { CodeGraphReader } from '../bridge/sqlite-ro.js';
import { parseNote, parseCbmNodeIds, parseTags, splitSections } from './frontmatter.js';
import {
  parseWikilinks,
  classifyWikilinkTarget,
  parseCodeNodeId,
  inferEdgeTypeFromContext,
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
      const content = readNote(opts.vaultPath, relPath);
      if (!content) continue;

      const parsed = parseNote(content);
      const fm = parsed.frontmatter;

      // Determine label from frontmatter 'type' or path.
      const label = inferLabelFromFrontmatter(fm, relPath);
      if (!label) {
        result.errors.push({ path: relPath, error: 'cannot infer label (set frontmatter `type` or move to a known dir)' });
        continue;
      }

      const title = extractTitle(parsed.body, relPath) ?? relPath.replace(/\.md$/i, "");
      const slug = slugify(title);
      const cbmNodeIds = parseCbmNodeIds(fm);
      const tags = parseTags(fm);

      // Validate status and source against enums.
      const rawStatus = (fm.status as string) ?? 'active';
      if (!(HUMAN_NODE_STATUSES as readonly string[]).includes(rawStatus)) {
        result.errors.push({
          path: relPath,
          error: `invalid status "${rawStatus}". Valid: ${HUMAN_NODE_STATUSES.join(', ')}`,
        });
        continue;
      }
      const status = rawStatus as HumanNodeStatus;

      const rawSource = (fm.source as string) ?? 'human';
      if (!(HUMAN_NODE_SOURCES as readonly string[]).includes(rawSource)) {
        result.errors.push({
          path: relPath,
          error: `invalid source "${rawSource}". Valid: ${HUMAN_NODE_SOURCES.join(', ')}`,
        });
        continue;
      }
      const source = rawSource as HumanNodeSource;

      // Extract HUMAN NOTES section content.
      const sections = splitSections(parsed.body);
      // Strip the known placeholder text — it's not real human content.
      const PLACEHOLDER = '> ✏️ This section belongs to the user. It will **never** be overwritten by Codebase Memory V2.';
      // Strip placeholder from the START of humanNotes (user may have added content after it).
        const humanBody = sections.humanNotes.startsWith(PLACEHOLDER)
          ? sections.humanNotes.substring(PLACEHOLDER.length).trim()
          : sections.humanNotes;

      // Check if human_node already exists (by obsidian_path or slug).
      const existingByPath = opts.humanStore.getNodeByObsidianPath(opts.project, relPath);
      const existingBySlug = slug ? opts.humanStore.getNodeBySlug(opts.project, slug) : null;

      // Detect slug-collision conflict: both exist but differ.
      if (existingByPath && existingBySlug && existingByPath.id !== existingBySlug.id) {
        result.errors.push({
          path: relPath,
          error: `slug collision: path-match node id=${existingByPath.id} and slug-match node id=${existingBySlug.id} are different. Skipping — resolve manually.`,
        });
        continue;
      }

      const existing = existingByPath ?? existingBySlug;
      const vaultHash = hashContent(content);

      if (existing) {
        // No-op detection: compare key fields.
        const sameContent = existing.body_markdown === humanBody;
        const sameTitle = existing.title === title;
        const sameCbmIds = JSON.stringify(existing.cbm_node_ids.slice().sort()) === JSON.stringify(cbmNodeIds.slice().sort());
        const sameTags = JSON.stringify(existing.tags.slice().sort()) === JSON.stringify(tags.slice().sort());
        const sameStatus = existing.status === status;
        if (sameContent && sameTitle && sameCbmIds && sameTags && sameStatus) {
          result.unchanged.push(relPath);
          // Still process wikilinks for edges.
        } else {
          if (!opts.dryRun) {
            opts.humanStore.updateNode(existing.id, {
              title,
              body_markdown: humanBody,
              frontmatter: fm,
              status,
              source,
              cbm_node_ids: cbmNodeIds,
              tags,
              obsidian_path: relPath,
            });
            opts.humanStore.markSynced(existing.id, 'import', vaultHash);
          }
          result.updated.push(relPath);
        }
      } else {
        if (!opts.dryRun) {
          const node = opts.humanStore.createNode({
            project: opts.project,
            label,
            title,
            body_markdown: humanBody,
            frontmatter: fm,
            status,
            source,
            cbm_node_ids: cbmNodeIds,
            tags,
            obsidian_path: relPath,
            source_file: relPath,
          });
          opts.humanStore.markSynced(node.id, 'import', vaultHash);
        }
        result.created.push(relPath);
      }

      if (cbmNodeIds.length === 0) {
        result.orphanNotes.push(relPath);
      }

      // Parse wikilinks and create/refresh edges.
      const sourceNode = existing ?? opts.humanStore.getNodeByObsidianPath(opts.project, relPath);
      if (sourceNode && !opts.dryRun) {
        // Parse wikilinks only from HUMAN NOTES section — AUTO-GENERATED wikilinks are
        // machine-generated and should not create edges (they would duplicate existing edges).
        const wikilinks = parseWikilinks(humanBody);
        const seenEdgeIds: number[] = [];
        for (const wl of wikilinks) {
          const kind = classifyWikilinkTarget(wl.target);
          if (kind === 'code') {
            const cbmId = parseCodeNodeId(wl.target);
            if (cbmId == null) continue;
            const edgeType = inferEdgeTypeFromContext(humanBody, wl);
            // createEdge is idempotent (returns existing edge if dup).
            const edge = opts.humanStore.createEdge({
              project: opts.project,
              source_human_node_id: sourceNode.id,
              target_kind: 'code',
              target_cbm_node_id: cbmId,
              type: edgeType,
              properties: { alias: wl.alias, inferred: true },
              source_file: relPath,
            });
            seenEdgeIds.push(edge.id);
          } else if (kind === 'human') {
            const targetNode = opts.humanStore.getNodeBySlug(opts.project, wl.target);
            if (!targetNode) continue;
            const edge = opts.humanStore.createEdge({
              project: opts.project,
              source_human_node_id: sourceNode.id,
              target_kind: 'human',
              target_human_node_id: targetNode.id,
              type: 'MENTIONS', // explicit type, included in dedup
              properties: { alias: wl.alias },
              source_file: relPath,
            });
            seenEdgeIds.push(edge.id);
          } else if (kind === 'path') {
            // Resolve path-style wikilink to a human node via obsidian_path.
            const targetPath = wl.target.endsWith('.md') ? wl.target : wl.target + '.md';
            const targetNode = opts.humanStore.getNodeByObsidianPath(opts.project, targetPath);
            if (!targetNode) continue;
            const edge = opts.humanStore.createEdge({
              project: opts.project,
              source_human_node_id: sourceNode.id,
              target_kind: 'human',
              target_human_node_id: targetNode.id,
              type: 'MENTIONS',
              properties: { alias: wl.alias, via: 'path' },
              source_file: relPath,
            });
            seenEdgeIds.push(edge.id);
          }
        }
        // Clean up stale edges that were created from this file but no longer exist in the note.
        const deleted = opts.humanStore.deleteStaleEdgesFromNode(sourceNode.id, relPath, seenEdgeIds);
        result.edgesDeleted += deleted;
        result.edgesCreated += seenEdgeIds.length;
      }
    } catch (e: any) {
      result.errors.push({ path: relPath, error: e.message });
    }
  }

  return result;
}

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

