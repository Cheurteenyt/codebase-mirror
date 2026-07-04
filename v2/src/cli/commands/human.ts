// v2/src/cli/commands/human.ts

import { Command } from 'commander';
import { HumanMemoryStore, defaultHumanDbPath } from '../../human/store.js';
import { HumanNodeLabel, HumanEdgeType, HUMAN_NODE_LABELS, HUMAN_EDGE_TYPES } from '../../human/schema.js';

export function registerHumanCommand(program: Command): void {
  const human = program.command('human').description('Manage human memory notes');

  human
    .command('create')
    .description('Create a human memory note')
    .option('--project <name>')
    .option('--type <label>', `Node label: ${HUMAN_NODE_LABELS.join(' | ')}`)
    .option('--title <title>', 'Title (required)')
    .option('--body <text>', 'Markdown body', '')
    .option('--status <status>', 'draft | active | reviewed | deprecated', 'active')
    .option('--tag <tag>', 'Tag (can be repeated)')
    .option('--link-cbm <id>', 'Link to cbm_node_id (can be repeated)')
    .option('--link-edge <type>', `Edge type for the link: ${HUMAN_EDGE_TYPES.join(' | ')}`, 'MENTIONS')
    .action((opts) => {
      if (!opts.title || !opts.type) {
        console.error('Error: --title and --type are required');
        process.exit(1);
      }
      if (!HUMAN_NODE_LABELS.includes(opts.type as HumanNodeLabel)) {
        console.error(`Error: invalid --type. Valid: ${HUMAN_NODE_LABELS.join(', ')}`);
        process.exit(1);
      }
      const project = opts.project || process.cwd().split(/[\\/]/).pop() || 'default';
      const tags: string[] = Array.isArray(opts.tag) ? opts.tag : (opts.tag ? [opts.tag] : []);
      const linkCbm: string[] = Array.isArray(opts.linkCbm) ? opts.linkCbm : (opts.linkCbm ? [opts.linkCbm] : []);
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));

      try {
        const node = humanStore.createNode({
          project,
          label: opts.type as HumanNodeLabel,
          title: opts.title,
          body_markdown: opts.body,
          status: opts.status,
          source: 'human',
          cbm_node_ids: linkCbm.map((s: string) => parseInt(s, 10)),
          tags,
        });

        // Create edges for each linked cbm node
        const edgeType = (opts.linkEdge as HumanEdgeType) || 'MENTIONS';
        for (const cbmIdStr of linkCbm) {
          const cbmId = parseInt(cbmIdStr, 10);
          humanStore.createEdge({
            project,
            source_human_node_id: node.id,
            target_kind: 'code',
            target_cbm_node_id: cbmId,
            type: edgeType,
          });
        }
        console.log(`✅ Created: id=${node.id}, slug=${node.slug}, path=${node.obsidian_path}`);
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
      const project = opts.project || process.cwd().split(/[\\/]/).pop() || 'default';
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      try {
        const nodes = humanStore.listNodes(project, {
          label: opts.type as HumanNodeLabel,
          status: opts.status as any,
          limit: parseInt(opts.limit, 10) || 200,
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
    .description('Show a single note')
    .argument('<id>', 'Note ID')
    .option('--project <name>')
    .action((idStr, opts) => {
      const id = parseInt(idStr, 10);
      const project = opts.project || process.cwd().split(/[\\/]/).pop() || 'default';
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      try {
        const node = humanStore.getNodeById(id);
        if (!node) {
          console.error(`Note ${id} not found`);
          process.exit(1);
        }
        console.log(JSON.stringify(node, null, 2));
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
        process.exit(1);
      }
      const noteId = parseInt(noteIdStr, 10);
      const cbmId = parseInt(opts.toCbmNode, 10);
      const project = opts.project || process.cwd().split(/[\\/]/).pop() || 'default';
      const humanStore = new HumanMemoryStore(defaultHumanDbPath(project));
      try {
        const edge = humanStore.createEdge({
          project,
          source_human_node_id: noteId,
          target_kind: 'code',
          target_cbm_node_id: cbmId,
          type: opts.edge as HumanEdgeType,
        });
        console.log(`✅ Edge created: id=${edge.id}, type=${edge.type}, target=${cbmId}`);
      } finally {
        humanStore.close();
      }
    });
}
