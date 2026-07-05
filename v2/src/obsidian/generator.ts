// v2/src/obsidian/generator.ts
// Generate Obsidian vault notes from human memory DB.
// CRITICAL: preserve ## HUMAN NOTES section when regenerating.
//
// R18 refactor: generateVault was a 235-line monolith. Split into 4 focused
// sub-functions, each with a single responsibility:
//   - syncHumanNodesToVault (step 1: existing human_nodes → vault)
//   - autoGenerateModuleNotes (step 2: high-degree modules → ModuleNote)
//   - autoGenerateRouteNotes (step 3: routes → RouteNote)
//   - generateVaultIndexAndTemplate (step 4+5: 00_Index.md + ADR template)

import { HumanMemoryStore } from '../human/store.js';
import { safeJsonParse, MAX_NODES_PER_LABEL } from '../constants.js';
import { HumanNode } from '../human/schema.js';
import { CodeGraphReader } from '../bridge/sqlite-ro.js';
import {
  parseNote,
  splitSections,
  mergeSections,
  buildFrontmatter,
  serializeNote,
} from './frontmatter.js';
import {
  ensureVaultDirs,
  writeNote,
  readNote,
  renderVaultIndex,
  getAdrTemplate,
} from './vault.js';
import { slugify } from '../human/schema.js';

export interface GenerateOptions {
  project: string;
  vaultPath: string;
  humanStore: HumanMemoryStore;
  codeReader?: CodeGraphReader;
  backupBeforeWrite?: boolean;
  dryRun?: boolean;
  autoGenerateModuleNotes?: boolean;
  autoGenerateRouteNotes?: boolean;
  minDegreeForModuleNote?: number;
  /** R19: if true, re-write all notes even if content hasn't changed. */
  force?: boolean;
}

export interface GenerateResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  backups: string[];
  errors: { path: string; error: string }[];
}

/** Page size for cursor-based pagination of human_nodes. */
const SYNC_PAGE_SIZE = 500;

/**
 * Main entry point — orchestrates the 5-step vault generation.
 * Each step is delegated to a focused sub-function for readability.
 */
export function generateVault(opts: GenerateOptions): GenerateResult {
  const result: GenerateResult = {
    created: [],
    updated: [],
    unchanged: [],
    backups: [],
    errors: [],
  };

  if (!opts.dryRun) {
    ensureVaultDirs(opts.vaultPath);
  }

  // Step 1: Sync all existing human_nodes → vault.
  syncHumanNodesToVault(opts, result);

  // Step 2: Auto-generate module notes for high-degree modules.
  if (opts.autoGenerateModuleNotes && opts.codeReader) {
    autoGenerateModuleNotes(opts, result);
  }

  // Step 3: Auto-generate route notes.
  if (opts.autoGenerateRouteNotes && opts.codeReader) {
    autoGenerateRouteNotes(opts, result);
  }

  // Steps 4+5: Generate 00_Index.md + ADR template.
  generateVaultIndexAndTemplate(opts, result);

  return result;
}

// ── Step 1: Sync existing human_nodes → vault ──────────────────────

/**
 * Iterate all human_nodes (cursor-paginated) and export each to the vault.
 * For existing files: preserve ## HUMAN NOTES, regenerate ## AUTO-GENERATED.
 * For new files: write the full template.
 */
function syncHumanNodesToVault(opts: GenerateOptions, result: GenerateResult): void {
  let offset = 0;
  while (true) {
    const page = opts.humanStore.listNodes(opts.project, { limit: SYNC_PAGE_SIZE, offset });
    if (page.length === 0) break;
    for (const node of page) {
      try {
        syncSingleNode(node, opts, result);
      } catch (e: any) {
        result.errors.push({ path: node.obsidian_path ?? `<node ${node.id}>`, error: e.message });
      }
    }
    if (page.length < SYNC_PAGE_SIZE) break;
    offset += SYNC_PAGE_SIZE;
  }
}

/**
 * Export a single human_node to the vault.
 * Creates a new file or updates an existing one (preserving HUMAN NOTES).
 */
function syncSingleNode(node: HumanNode, opts: GenerateOptions, result: GenerateResult): void {
  const relPath = node.obsidian_path;
  if (!relPath) {
    result.errors.push({
      path: `<unknown for node ${node.id}>`,
      error: `no obsidian_path on node id=${node.id} label=${node.label} title="${node.title}" project="${node.project}"`,
    });
    return;
  }

  const existingContent = readNote(opts.vaultPath, relPath);
  const backupEnabled = opts.backupBeforeWrite ?? true;

  if (existingContent === null) {
    // Create new file.
    const newContent = renderNoteForVault(node, opts.codeReader);
    if (!opts.dryRun) {
      const writeResult = writeNote(opts.vaultPath, relPath, newContent, { backupBeforeWrite: backupEnabled });
      if (writeResult.backupPath) result.backups.push(writeResult.backupPath);
      opts.humanStore.markSynced(node.id, 'export');
    }
    result.created.push(relPath);
  } else {
    // Update existing — preserve HUMAN NOTES.
    const fullContent = rebuildNoteContent(existingContent, node, opts.codeReader);
    // Compare ignoring last_synced (changes on every export → infinite re-writes).
    const normalizeForDiff = (s: string) => s.replace(/^last_synced:[^\n]*\n?/gm, '');
    // R19: --force bypasses the diff check and re-writes all notes.
    const hasChanged = normalizeForDiff(fullContent) !== normalizeForDiff(existingContent);
    if (hasChanged || opts.force) {
      if (!opts.dryRun) {
        const writeResult = writeNote(opts.vaultPath, relPath, fullContent, { backupBeforeWrite: backupEnabled });
        if (writeResult.backupPath) result.backups.push(writeResult.backupPath);
        opts.humanStore.markSynced(node.id, 'export');
      }
      result.updated.push(relPath);
    } else {
      result.unchanged.push(relPath);
    }
  }
}

/**
 * Rebuild a note's content by merging the existing HUMAN NOTES with
 * freshly-generated AUTO-GENERATED section and frontmatter.
 */
function rebuildNoteContent(existingContent: string, node: HumanNode, codeReader?: CodeGraphReader): string {
  const parsed = parseNote(existingContent);
  const sections = splitSections(parsed.body);
  const newAutoGenerated = renderAutoGeneratedSection(node, codeReader);
  const newBody = mergeSections(sections.preSectionContent, newAutoGenerated, sections.humanNotes);
  const newFm = mergeFrontmatter(parsed.frontmatter, buildFrontmatter(node));
  return serializeNote(newFm, newBody);
}

// ── Step 2: Auto-generate ModuleNotes ──────────────────────────────

/**
 * For each module with degree >= minDegreeForModuleNote, create a ModuleNote
 * if one doesn't already exist. Uses bulk degree fetch (no N+1).
 */
function autoGenerateModuleNotes(opts: GenerateOptions, result: GenerateResult): void {
  if (!opts.codeReader) return;
  const minDegree = opts.minDegreeForModuleNote ?? 20;
  const modules = opts.codeReader.listModules(opts.project, MAX_NODES_PER_LABEL);
  const moduleIds = modules.map((m) => m.id);
  const degreeMap = opts.codeReader.getBulkNodeDegrees(moduleIds);

  for (const module of modules) {
    const degree = degreeMap.get(module.id) ?? 0;
    if (degree < minDegree) continue;

    const slug = slugify(module.name);
    if (!slug) continue;
    const relPath = `Modules/${slug}.md`;

    // Skip if file already exists or a human_node already exists for this path.
    if (readNote(opts.vaultPath, relPath)) {
      result.unchanged.push(relPath);
      continue;
    }
    if (opts.humanStore.getNodeByObsidianPath(opts.project, relPath)) continue;

    createAutoNote(opts, result, {
      relPath,
      label: 'ModuleNote',
      title: `Module: ${module.name}`,
      frontmatter: {
        type: 'module',
        source: 'generated',
        status: 'active',
        cbm_node_id: module.id,
        cbm_node_type: 'Module',
        last_generated: new Date().toISOString().split('T')[0],
      },
      bodyTitle: `# Module: ${module.name}`,
      autoContent: renderModuleAutoGenerated(module, degree, opts.codeReader),
      cbm_node_ids: [module.id],
      tags: ['module', slug],
    });
  }
}

// ── Step 3: Auto-generate RouteNotes ───────────────────────────────

/**
 * For each route in the code graph, create a RouteNote if one doesn't exist.
 */
function autoGenerateRouteNotes(opts: GenerateOptions, result: GenerateResult): void {
  if (!opts.codeReader) return;
  const routes = opts.codeReader.listRoutes(opts.project, MAX_NODES_PER_LABEL);

  for (const route of routes) {
    const props = safeJsonParse(route.properties_json, {} as Record<string, any>);
    const method = props.route_method || 'GET';
    const path = props.route_path || route.name;
    const slug = slugify(`${method}-${path}`);
    if (!slug) continue;
    const relPath = `Routes/${slug}.md`;

    if (readNote(opts.vaultPath, relPath)) {
      result.unchanged.push(relPath);
      continue;
    }
    if (opts.humanStore.getNodeByObsidianPath(opts.project, relPath)) continue;

    createAutoNote(opts, result, {
      relPath,
      label: 'RouteNote',
      title: `Route: ${method} ${path}`,
      frontmatter: {
        type: 'route',
        source: 'generated',
        status: 'active',
        cbm_node_id: route.id,
        cbm_node_type: 'Route',
        last_generated: new Date().toISOString().split('T')[0],
      },
      bodyTitle: `# Route: ${method} ${path}`,
      autoContent: renderRouteAutoGenerated(route, opts.codeReader),
      cbm_node_ids: [route.id],
      tags: ['route', method.toLowerCase()],
    });
  }
}

// ── Shared helper for auto-note creation ───────────────────────────

interface AutoNoteSpec {
  relPath: string;
  label: 'ModuleNote' | 'RouteNote';
  title: string;
  frontmatter: Record<string, unknown>;
  bodyTitle: string;
  autoContent: string;
  cbm_node_ids: number[];
  tags: string[];
}

/**
 * Create a human_node + vault file for an auto-generated note (module or route).
 * Handles dry-run, backup, markSynced, and error collection.
 */
function createAutoNote(opts: GenerateOptions, result: GenerateResult, spec: AutoNoteSpec): void {
  const body = mergeSections(spec.bodyTitle, spec.autoContent, '');
  const content = serializeNote(spec.frontmatter, body);

  if (!opts.dryRun) {
    try {
      const node = opts.humanStore.createNode({
        project: opts.project,
        label: spec.label,
        title: spec.title,
        body_markdown: '',
        frontmatter: spec.frontmatter,
        source: 'generated',
        status: 'active',
        cbm_node_ids: spec.cbm_node_ids,
        tags: spec.tags,
        obsidian_path: spec.relPath,
      });
      const writeResult = writeNote(opts.vaultPath, spec.relPath, content, {
        backupBeforeWrite: opts.backupBeforeWrite ?? true,
      });
      if (writeResult.backupPath) result.backups.push(writeResult.backupPath);
      opts.humanStore.markSynced(node.id, 'export');
    } catch (e: any) {
      result.errors.push({ path: spec.relPath, error: `auto-${spec.label.toLowerCase()}-note failed: ${e.message}` });
      return; // Don't add to created if it failed
    }
  }
  result.created.push(spec.relPath);
}

// ── Steps 4+5: Vault index + ADR template ──────────────────────────

/**
 * Generate 00_Index.md with accurate counts and the ADR template file.
 */
function generateVaultIndexAndTemplate(opts: GenerateOptions, _result: GenerateResult): void {
  // Step 4: 00_Index.md
  let modulesCount = 0;
  let routesCount = 0;
  if (opts.codeReader) {
    const labelCounts = opts.codeReader.countNodesByLabel(opts.project);
    modulesCount = labelCounts['Module'] ?? 0;
    routesCount = labelCounts['Route'] ?? 0;
  }
  // R39: use countNodesByLabel (1 query instead of 4).
  const humanLabelCounts = opts.humanStore.countNodesByLabel(opts.project);
  const indexContent = renderVaultIndex({
    projectName: opts.project,
    stats: {
      modulesCount,
      routesCount,
      adrsCount: humanLabelCounts['ADR'] ?? 0,
      bugsCount: humanLabelCounts['BugNote'] ?? 0,
      refactorsCount: humanLabelCounts['RefactorPlan'] ?? 0,
      notesTotal: humanLabelCounts['_total'] ?? 0,
    },
  });
  if (!opts.dryRun) {
    writeNote(opts.vaultPath, '00_Index.md', indexContent, {
      backupBeforeWrite: opts.backupBeforeWrite ?? true,
    });
  }

  // Step 5: ADR template (only if it doesn't exist).
  const templateRelPath = 'ADR/ADR-000-template.md';
  if (!readNote(opts.vaultPath, templateRelPath) && !opts.dryRun) {
    writeNote(opts.vaultPath, templateRelPath, getAdrTemplate(), {
      backupBeforeWrite: false,
    });
  }
}

// ── Rendering functions (unchanged from pre-R18) ───────────────────

function renderNoteForVault(node: HumanNode, codeReader?: CodeGraphReader): string {
  const fm = buildFrontmatter(node);
  const autoContent = renderAutoGeneratedSection(node, codeReader);
  const body = mergeSections(`# ${node.title}`, autoContent, node.body_markdown);
  return serializeNote(fm, body);
}

function renderAutoGeneratedSection(node: HumanNode, codeReader?: CodeGraphReader): string {
  const lines: string[] = [];

  lines.push('> ⚠️ This section is controlled by Codebase Memory V2 and may be regenerated.');
  lines.push('> Do not edit — your changes would be lost on the next sync.');
  lines.push('');

  lines.push('### Metadata');
  lines.push('');
  lines.push(`- **Type** : ${node.label}`);
  lines.push(`- **Status** : ${node.status}`);
  lines.push(`- **Source** : ${node.source}`);
  lines.push(`- **Slug** : ${node.slug}`);
  lines.push(`- **Created** : ${node.created_at.split('T')[0]}`);
  lines.push(`- **Updated** : ${node.updated_at.split('T')[0]}`);
  // NOTE: last_synced_at is in frontmatter (last_synced key), NOT in the body.
  // Putting it in the body causes infinite re-writes (the timestamp changes on
  // every export, making the content always differ from the previous version).
  if (node.author) {
    lines.push(`- **Author** : ${node.author}`);
  }
  lines.push('');

  if (node.cbm_node_ids.length > 0) {
    lines.push('### Links to code');
    lines.push('');
    // Bulk-fetch code nodes to avoid N+1.
    if (codeReader) {
      const nodesMap = codeReader.getNodesByIds(node.cbm_node_ids);
      for (const cbmId of node.cbm_node_ids) {
        const codeNode = nodesMap.get(cbmId);
        if (codeNode) {
          lines.push(`- [[${cbmId}]] — ${codeNode.label}:${codeNode.name} (\`${codeNode.file_path}:${codeNode.start_line}\`)`);
        } else {
          lines.push(`- [[${cbmId}]] — *(code node not found)*`);
        }
      }
    } else {
      for (const cbmId of node.cbm_node_ids) {
        lines.push(`- [[${cbmId}]]`);
      }
    }
    lines.push('');
  }

  if (node.tags.length > 0) {
    lines.push('### Tags');
    lines.push('');
    // Render as raw #tag (no backticks) so Obsidian recognizes them as inline tags.
    lines.push(node.tags.map((t) => '#' + t).join(' '));
    lines.push('');
  }

  return lines.join('\n');
}

function renderModuleAutoGenerated(
  module: { id: number; name: string; qualified_name: string; file_path: string; start_line: number; end_line: number; properties_json: string },
  degree: number,
  codeReader: CodeGraphReader
): string {
  const lines: string[] = [];
  const props = safeJsonParse(module.properties_json, {} as Record<string, any>);

  lines.push('> ⚠️ This section is controlled by Codebase Memory V2 and may be regenerated.');
  lines.push('');

  lines.push('### Overview');
  lines.push('');
  lines.push(`- **Path** : \`${module.file_path}\``);
  lines.push(`- **Lines** : ${module.start_line}-${module.end_line}`);
  lines.push(`- **Degree** : ${degree} ${degree >= 30 ? '⚠️ **critical**' : ''}`);
  lines.push(`- **Qualified name** : \`${module.qualified_name}\``);
  lines.push('');

  const neighbors = codeReader.getNeighbors(module.id, 'both', 50);
  if (neighbors.length > 0) {
    lines.push('### Dependencies (top 50)');
    lines.push('');
    for (const { edge, node } of neighbors.slice(0, 50)) {
      lines.push(`- \`${edge.type}\` ↔ [[${node.id}]] — ${node.label}:${node.name}`);
    }
    lines.push('');
  }

  if (Object.keys(props).length > 0) {
    lines.push('### Properties');
    lines.push('');
    for (const [key, value] of Object.entries(props)) {
      lines.push(`- **${key}** : ${JSON.stringify(value)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderRouteAutoGenerated(
  route: { id: number; name: string; qualified_name: string; file_path: string; start_line: number; end_line: number; properties_json: string },
  codeReader: CodeGraphReader
): string {
  const lines: string[] = [];
  const props = safeJsonParse(route.properties_json, {} as Record<string, any>);

  lines.push('> ⚠️ This section is controlled by Codebase Memory V2 and may be regenerated.');
  lines.push('');

  lines.push('### Overview');
  lines.push('');
  lines.push(`- **Handler** : \`${route.file_path}:${route.start_line}\``);
  lines.push(`- **Qualified name** : \`${route.qualified_name}\``);
  if (props.route_method) lines.push(`- **HTTP method** : ${props.route_method}`);
  if (props.route_path) lines.push(`- **Path** : ${props.route_path}`);
  lines.push('');

  const neighbors = codeReader.getNeighbors(route.id, 'out', 30);
  if (neighbors.length > 0) {
    lines.push('### Flow (handlers, services, repositories)');
    lines.push('');
    for (const { edge, node } of neighbors.slice(0, 30)) {
      lines.push(`- \`${edge.type}\` → [[${node.id}]] — ${node.label}:${node.name}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Merge frontmatter: DB wins for technical keys, existing wins for editorial keys.
 * R15: removes stale `last_generated` from existing vault files.
 */
function mergeFrontmatter(
  existing: Record<string, unknown>,
  fresh: Record<string, unknown>
): Record<string, unknown> {
  const editorialKeys = new Set(['title', 'description', 'notes']);
  const result: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(fresh)) {
    if (!editorialKeys.has(k) || result[k] == null) {
      result[k] = v;
    }
  }
  // R15: remove stale `last_generated` from existing vault files.
  if (!('last_generated' in fresh) && 'last_generated' in result) {
    delete result['last_generated'];
  }
  return result;
}
