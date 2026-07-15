// v2/src/mcp/tools/create_human_note.ts

import { BaseTool } from './base.js';
import { ToolDefinition } from './index.js';
import { HUMAN_NODE_LABELS, HUMAN_EDGE_TYPES, HUMAN_NODE_STATUSES } from '../../human/schema.js';

export class CreateHumanNoteTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'create_human_note',
      description: 'Create a human memory note (ADR, BugNote, RefactorPlan, Convention, etc.) and optionally link it to one or more code nodes in a single call. The note is stored in the human DB and will appear in the Obsidian vault after the next sync.',
      annotations: {
        title: 'Create human note',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project name (defaults to the server\'s configured project)' },
          label: {
            type: 'string',
            enum: HUMAN_NODE_LABELS as readonly string[],
            description: 'Type of human note',
          },
          title: { type: 'string', description: 'Title (also used to generate the slug and Obsidian path). Must not contain newlines.', minLength: 1 },
          body_markdown: { type: 'string', description: 'Markdown body (goes into HUMAN NOTES section)', default: '' },
          status: { type: 'string', enum: HUMAN_NODE_STATUSES as readonly string[], default: 'active' },
          tags: { type: 'array', items: { type: 'string' } },
          links: {
            type: 'array',
            description: 'Code nodes to link to (validated against the code graph if a reader is available)',
            items: {
              type: 'object',
              properties: {
                cbm_node_id: { type: 'number' },
                edge_type: {
                  type: 'string',
                  enum: HUMAN_EDGE_TYPES as readonly string[],
                },
              },
              required: ['cbm_node_id', 'edge_type'],
            },
          },
          author: { type: 'string' },
        },
        required: ['label', 'title'],
        additionalProperties: false,
      },
      handler: CreateHumanNoteTool,
    };
  }

  async handle(args: Record<string, unknown>) {
    try {
      const project = this.optionalString(args, 'project') ?? this.project;
      const label = this.requireEnum(args, 'label', HUMAN_NODE_LABELS);
      const title = this.requireString(args, 'title');
      const bodyMarkdown = this.optionalString(args, 'body_markdown') ?? '';
      const status = args.status ? this.requireEnum(args, 'status', HUMAN_NODE_STATUSES) : 'active';
      const tags = (this.optionalArray(args, 'tags') ?? []).filter((t): t is string => typeof t === 'string' && t.length > 0);
      const links = (this.optionalArray(args, 'links') ?? []) as Array<{ cbm_node_id: number; edge_type: any }>;
      const author = this.optionalString(args, 'author');

      const cbmNodeIds: number[] = [];
      const validatedLinks: Array<{ cbm_node_id: number; edge_type: any; exists: boolean }> = [];

      // R40 (M2): validate edge_type and coerce cbm_node_id in a first pass,
      // then batch-verify all cbm_node_ids against the code graph in a single
      // getNodesByIds call instead of N× getNodeById. For a note linking 10
      // code symbols, this is 1 query instead of 10. Also reports ALL missing
      // ids in one error message instead of short-circuiting on the first.
      for (const link of links) {
        const cbmId = typeof link.cbm_node_id === 'number'
          ? link.cbm_node_id
          : typeof link.cbm_node_id === 'string'
            ? Number(link.cbm_node_id)
            : NaN;
        if (!Number.isFinite(cbmId)) {
          return this.error(`Invalid cbm_node_id in links: ${JSON.stringify(link.cbm_node_id)} (must be a number)`);
        }
        if (!HUMAN_EDGE_TYPES.includes(link.edge_type)) {
          return this.error(`Invalid edge_type "${link.edge_type}" in links. Valid: ${HUMAN_EDGE_TYPES.join(', ')}`);
        }
        cbmNodeIds.push(cbmId);
        validatedLinks.push({ cbm_node_id: cbmId, edge_type: link.edge_type, exists: true });
      }

      if (this.codeReader && cbmNodeIds.length > 0) {
        const foundMap = this.codeReader.getNodesByIds(cbmNodeIds);
        const missing = cbmNodeIds.filter(id => !foundMap.has(id));
        if (missing.length > 0) {
          return this.error(
            `Code node(s) not found in project "${project}": id=${missing.join(', id=')}. ` +
            `Indexed nodes may have different IDs after re-indexing — verify with search_code_and_memory first.`
          );
        }
      } else if (cbmNodeIds.length > 0) {
        // No codeReader available — mark all as unverifiable (preserves prior behavior).
        for (const vl of validatedLinks) vl.exists = false;
      }

      // R26 (Bug #4 fix): wrap createNode + createEdge in a single transaction
      // so either everything commits or nothing does. Previously, if createEdge
      // threw after createNode succeeded, the node (and any earlier edges)
      // remained committed — leaving an orphan that a retry would duplicate.
      let node: any;
      const createdEdges: Array<{ id: number; type: string; cbm_node_id: number }> = [];
      const db = this.humanStore.getRawDb();
      const tx = db.transaction(() => {
        node = this.humanStore.createNode({
          project,
          label,
          title,
          body_markdown: bodyMarkdown,
          status,
          source: 'human',
          cbm_node_ids: cbmNodeIds,
          tags,
          author,
        });

        for (const link of validatedLinks) {
          const edge = this.humanStore.createEdge({
            project,
            source_human_node_id: node.id,
            target_kind: 'code',
            target_cbm_node_id: link.cbm_node_id,
            type: link.edge_type,
          });
          createdEdges.push({ id: edge.id, type: link.edge_type, cbm_node_id: link.cbm_node_id });
        }
      });
      tx();

      return this.json({
        success: true,
        node: {
          id: node.id,
          label: node.label,
          title: node.title,
          slug: node.slug,
          obsidian_path: node.obsidian_path,
          status: node.status,
          cbm_node_ids: node.cbm_node_ids,
          tags: node.tags,
          created_at: node.created_at,
        },
        edges: createdEdges,
        next_step: 'Run `cbm-v2 obsidian sync --direction export` to generate the note in the Obsidian vault.',
      });
    } catch (e: unknown) {
      return this.error((e instanceof Error ? e.message : String(e)));
    }
  }
}
