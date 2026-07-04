// v2/src/obsidian/importer.ts
// Import Obsidian vault notes → human memory DB.

import { HumanMemoryStore } from '../human/store.js';
import { CodeGraphReader } from '../bridge/sqlite-ro.js';
import { parseNote, parseCbmNodeIds, parseTags } from './frontmatter.js';
import { parseWikilinks, classifyWikilinkTarget, parseCodeNodeId, inferEdgeTypeFromContext } from './wikilinks.js';
import { walkVault, readNote } from './vault.js';
import { slugify, HumanNodeLabel, isHumanNodeLabel } from '../human/schema.js';

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
  orphanNotes: string[];   // notes without cbm_node_id
  edgesCreated: number;
  errors: { path: string; error: string }[];
}

export function importVault(opts: ImportOptions): ImportResult {
  const result: ImportResult = {
    created: [],
    updated: [],
    unchanged: [],
    orphanNotes: [],
    edgesCreated: 0,
    errors: [],
  };

  const files = walkVault(opts.vaultPath);
  for (const relPath of files) {
    if (relPath === '00_Index.md' || relPath.endsWith('ADR-000-template.md')) continue;
    try {
      const content = readNote(opts.vaultPath, relPath);
      if (!content) continue;

      const parsed = parseNote(content);
      const fm = parsed.frontmatter;

      // Determine label from frontmatter 'type' or path
      const label = inferLabelFromFrontmatter(fm, relPath);
      if (!label) {
        result.errors.push({ path: relPath, error: 'cannot infer label' });
        continue;
      }

      const title = extractTitle(parsed.body) ?? relPath;
      const slug = slugify(title);
      const cbmNodeIds = parseCbmNodeIds(fm);
      const tags = parseTags(fm);
      const status = (fm.status as string) ?? 'active';
      const source = (fm.source as string) ?? 'human';

      // Extract HUMAN NOTES section content
      const sections = splitSectionsForImport(parsed.body);
      const humanBody = sections.humanNotes;

      // Check if human_node already exists (by obsidian_path or slug)
      const existingByPath = opts.humanStore.getNodeByObsidianPath(opts.project, relPath);
      const existingBySlug = opts.humanStore.getNodeBySlug(opts.project, slug);

      if (existingByPath || existingBySlug) {
        // Update existing
        const existing = existingByPath ?? existingBySlug;
        if (existing && !opts.dryRun) {
          opts.humanStore.updateNode(existing.id, {
            title,
            body_markdown: humanBody,
            frontmatter: fm,
            status: status as any,
            source: source as any,
            cbm_node_ids: cbmNodeIds,
            tags,
            obsidian_path: relPath,
          });
          opts.humanStore.markSynced(existing.id, 'import');
        }
        result.updated.push(relPath);
      } else {
        // Create new
        if (!opts.dryRun) {
          const node = opts.humanStore.createNode({
            project: opts.project,
            label,
            title,
            body_markdown: humanBody,
            frontmatter: fm,
            status: status as any,
            source: source as any,
            cbm_node_ids: cbmNodeIds,
            tags,
            obsidian_path: relPath,
            source_file: relPath,
          });
          opts.humanStore.markSynced(node.id, 'import');
        }
        result.created.push(relPath);
      }

      if (cbmNodeIds.length === 0) {
        result.orphanNotes.push(relPath);
      }

      // Parse wikilinks and create edges
      const wikilinks = parseWikilinks(parsed.body);
      const sourceNode = existingByPath ?? existingBySlug;
      if (sourceNode && !opts.dryRun) {
        for (const wl of wikilinks) {
          const kind = classifyWikilinkTarget(wl.target);
          if (kind === 'code') {
            const cbmId = parseCodeNodeId(wl.target);
            if (cbmId == null) continue;
            const edgeType = inferEdgeTypeFromContext(parsed.body, wl);
            // Check if edge already exists
            const existingEdges = opts.humanStore.listEdgesFromNode(sourceNode.id);
            const alreadyExists = existingEdges.some(
              (e) => e.target_kind === 'code' && e.target_cbm_node_id === cbmId && e.type === edgeType
            );
            if (!alreadyExists) {
              opts.humanStore.createEdge({
                project: opts.project,
                source_human_node_id: sourceNode.id,
                target_kind: 'code',
                target_cbm_node_id: cbmId,
                type: edgeType,
                properties: { alias: wl.alias, inferred: true },
                source_file: relPath,
              });
              result.edgesCreated++;
            }
          } else if (kind === 'human') {
            const targetNode = opts.humanStore.getNodeBySlug(opts.project, wl.target);
            if (!targetNode) continue;
            const existingEdges = opts.humanStore.listEdgesFromNode(sourceNode.id);
            const alreadyExists = existingEdges.some(
              (e) => e.target_kind === 'human' && e.target_human_node_id === targetNode.id
            );
            if (!alreadyExists) {
              opts.humanStore.createEdge({
                project: opts.project,
                source_human_node_id: sourceNode.id,
                target_kind: 'human',
                target_human_node_id: targetNode.id,
                type: 'MENTIONS',
                properties: { alias: wl.alias },
                source_file: relPath,
              });
              result.edgesCreated++;
            }
          }
        }
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

  // Infer from path
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

function extractTitle(body: string): string | null {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function splitSectionsForImport(body: string): { autoGenerated: string; humanNotes: string } {
  const autoIdx = body.indexOf('## AUTO-GENERATED');
  const humanIdx = body.indexOf('## HUMAN NOTES');

  if (autoIdx === -1 && humanIdx === -1) {
    return { autoGenerated: '', humanNotes: body };
  }

  let humanNotes = '';
  if (humanIdx !== -1) {
    humanNotes = body.substring(humanIdx).replace(/^## HUMAN NOTES\r?\n?/, '').trim();
  } else if (autoIdx !== -1) {
    // Only AUTO-GENERATED, no HUMAN NOTES — take everything after AUTO-GENERATED
    humanNotes = '';
  } else {
    humanNotes = body;
  }

  return { autoGenerated: '', humanNotes };
}
