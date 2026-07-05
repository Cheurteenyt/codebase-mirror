// v2/src/cli/commands/human.ts

import { Command } from 'commander';
import { HumanMemoryStore, defaultHumanDbPath } from '../../human/store.js';
import {
  HumanNodeLabel,
  HumanEdgeType,
  HUMAN_NODE_LABELS,
  HUMAN_EDGE_TYPES,
  HUMAN_NODE_STATUSES,
  HumanNodeStatus,
} from '../../human/schema.js';
import { deriveProjectName } from '../../config.js';

function deriveProject(opts: any): string {
  return opts.project || deriveProjectName();
}

function parseIntStrict(s: string, flagName: string): number {
  const n = Number(s);
  if (!Number.isFinite(n)) {
    throw new Error(`${flagName} must be a number, got "${s}"`);
  }
  return n;
}

export function registerHumanCommand(program: Command): void {
  const human = program.command('human').description('Manage human memory notes');

  human
    .command('create')
    .description('Create a human memory note')
    .option('--project <name>')
    .option('--type <label>', `Node label: ${HUMAN_NODE_LABELS.join(' | ')}`)
    .option('--title <title>', 'Title (required)')
    .option('--body <text>', 'Markdown body', '')
    .option('--status <status>', `${HUMAN_NODE_STATUSES.join(' | ')}`, 'active')
    .option('--tag <tag...>', 'Tag (can be repeated)')
    .option('--link-cbm <id...>', 'Link to cbm_node_id (can be repeated)')
    .option('--link-edge <type>', `Edge type for the link: ${HUMAN_EDGE_TYPES.join(' | ')}`, 'MENTIONS')
    .action((opts) => {
      if (!opts.title || !opts.type) {
        console.error('Error: --title and --type are required');
        process.exitCode = 1;
        return;
      }
      if (!HUMAN_NODE_LABELS.includes(opts.type as HumanNodeLabel)) {
        console.error(`Error: invalid --type "${opts.type}". Valid: ${HUMAN_NODE_LABELS.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      if (!HUMAN_NODE_STATUSES.includes(opts.status)) {
        console.error(`Error: invalid --status "${opts.status}". Valid: ${HUMAN_NODE_STATUSES.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      // R15: always validate --link-edge, even if no --link-cbm is provided.
      // Previously the user could pass --link-edge INVALID without --link-cbm
      // and the invalid value was silently accepted (no edges created, no error).
      // This was misleading — the user might think the edge type would be used.
      if (opts.linkEdge && !HUMAN_EDGE_TYPES.includes(opts.linkEdge as HumanEdgeType)) {
        console.error(`Error: invalid --link-edge "${opts.linkEdge}". Valid: ${HUMAN_EDGE_TYPES.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const project = deriveProject(opts);
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));

      try {
        const tags: string[] = Array.isArray(opts.tag) ? opts.tag : (opts.tag ? [opts.tag] : []);
        const linkCbmStrs: string[] = Array.isArray(opts.linkCbm) ? opts.linkCbm : (opts.linkCbm ? [opts.linkCbm] : []);

        try {
          const linkCbm = linkCbmStrs.map((s) => parseIntStrict(s, '--link-cbm'));
          const node = humanStore.createNode({
            project,
            label: opts.type as HumanNodeLabel,
            title: opts.title,
            body_markdown: opts.body,
            status: opts.status,
            source: 'human',
            cbm_node_ids: linkCbm,
            tags,
          });

          const edgeType = (opts.linkEdge as HumanEdgeType) || 'MENTIONS';
          for (const cbmId of linkCbm) {
            humanStore.createEdge({
              project,
              source_human_node_id: node.id,
              target_kind: 'code',
              target_cbm_node_id: cbmId,
              type: edgeType,
            });
          }
          console.log(`✅ Created: id=${node.id}, slug=${node.slug}, path=${node.obsidian_path}`);
          if (linkCbm.length > 0) {
            console.log(`   Linked to ${linkCbm.length} code node(s) via ${edgeType} edges.`);
          }
        } catch (e: any) {
          console.error(`Error: ${e.message}`);
          process.exitCode = 1;
          return;
        }
      } catch (e: any) {
        console.error(`Error: ${e.message}`);
        process.exitCode = 1;
      } finally {
        humanStore.close();
      }
    });

  human
    .command('list')
    .description('List human memory notes')
    .option('--project <name>')
    .option('--type <label>')
    .option('--status <status>')
    .option('--limit <n>', '200')
    .action((opts) => {
      if (opts.type && !HUMAN_NODE_LABELS.includes(opts.type as HumanNodeLabel)) {
        console.error(`Error: invalid --type "${opts.type}". Valid: ${HUMAN_NODE_LABELS.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      if (opts.status && !HUMAN_NODE_STATUSES.includes(opts.status as HumanNodeStatus)) {
        console.error(`Error: invalid --status "${opts.status}". Valid: ${HUMAN_NODE_STATUSES.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const project = deriveProject(opts);
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      try {
        const nodes = humanStore.listNodes(project, {
          label: opts.type as HumanNodeLabel,
          status: opts.status as HumanNodeStatus,
          limit: (() => { const n = parseInt(opts.limit, 10); return Number.isFinite(n) ? n : 200; })(),
        });
        if (nodes.length === 0) {
          console.log('No notes found.');
          return;
        }
        console.log(`${nodes.length} note(s):`);
        for (const n of nodes) {
          console.log(`  [${n.id}] ${n.label} — ${n.title} (${n.status})`);
          console.log(`       path: ${n.obsidian_path ?? '—'}`);
          console.log(`       updated: ${n.updated_at}`);
        }
      } finally {
        humanStore.close();
      }
    });

  human
    .command('show')
    .description('Show a single note (JSON output, includes edges)')
    .argument('<id>', 'Note ID')
    .option('--project <name>')
    .action((idStr, opts) => {
      const project = deriveProject(opts);
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      try {
        const id = parseIntStrict(idStr, '<id>');
        const node = humanStore.getNodeById(id);
        if (!node) {
          console.error(`Note ${id} not found`);
          process.exitCode = 1;
          return;
        }
        // R15: include edges so the user can see what the note is linked to.
        const edges = humanStore.listEdgesFromNode(id, 1000);
        const output = {
          ...node,
          edges: edges.map((e) => ({
            id: e.id,
            type: e.type,
            target_kind: e.target_kind,
            target_cbm_node_id: e.target_cbm_node_id,
            target_human_node_id: e.target_human_node_id,
            created_at: e.created_at,
          })),
        };
        console.log(JSON.stringify(output, null, 2));
      } catch (e: any) {
        console.error(`Error: ${e.message}`);
        process.exitCode = 1;
      } finally {
        humanStore.close();
      }
    });

  human
    .command('link')
    .description('Link a note to a code node')
    .argument('<noteId>', 'Human note ID')
    .option('--project <name>')
    .option('--to-cbm-node <id>', 'Target cbm_node_id (required)')
    .option('--edge <type>', `Edge type: ${HUMAN_EDGE_TYPES.join(' | ')}`, 'MENTIONS')
    .action((noteIdStr, opts) => {
      if (!opts.toCbmNode) {
        console.error('Error: --to-cbm-node is required');
        process.exitCode = 1;
        return;
      }
      if (!HUMAN_EDGE_TYPES.includes(opts.edge as HumanEdgeType)) {
        console.error(`Error: invalid --edge "${opts.edge}". Valid: ${HUMAN_EDGE_TYPES.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const project = deriveProject(opts);
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      try {
        const noteId = parseIntStrict(noteIdStr, '<noteId>');
        const cbmId = parseIntStrict(opts.toCbmNode, '--to-cbm-node');
        const node = humanStore.getNodeById(noteId);
        if (!node) {
          console.error(`Error: note ${noteId} not found`);
          process.exitCode = 1;
          return;
        }
        if (node.project !== project) {
          console.error(`Error: note ${noteId} belongs to project "${node.project}", not "${project}"`);
          process.exitCode = 1;
          return;
        }
        try {
          const edge = humanStore.createEdge({
            project,
            source_human_node_id: noteId,
            target_kind: 'code',
            target_cbm_node_id: cbmId,
            type: opts.edge as HumanEdgeType,
          });
          console.log(`✅ Edge created: id=${edge.id}, type=${edge.type}, target=${cbmId}`);
        } catch (e: any) {
          console.error(`Error: ${e.message}`);
          process.exitCode = 1;
          return;
        }
      } catch (e: any) {
        console.error(`Error: ${e.message}`);
        process.exitCode = 1;
      } finally {
        humanStore.close();
      }
    });
}
