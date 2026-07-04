// v2/src/mcp/tools/create_human_note.ts

import { BaseTool } from './base.js';
import { ToolDefinition } from './index.js';
import { HumanNodeLabel, HumanEdgeType } from '../../human/schema.js';

export class CreateHumanNoteTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'create_human_note',
      description: 'Create a human memory note (ADR, BugNote, RefactorPlan, Convention, etc.) and optionally link it to one or more code nodes in a single call. The note is stored in the human DB and will appear in the Obsidian vault after the next sync.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          label: {
            type: 'string',
            enum: ['ArchitectureNote', 'ADR', 'BugNote', 'RefactorPlan', 'LegacyNote', 'Convention', 'Prompt', 'JournalEntry', 'ModuleNote', 'RouteNote', 'RiskNote'],
            description: 'Type of human note',
          },
          title: { type: 'string', description: 'Title (also used to generate the slug and Obsidian path)' },
          body_markdown: { type: 'string', description: 'Markdown body (goes into HUMAN NOTES section)', default: '' },
          status: { type: 'string', enum: ['draft', 'active', 'reviewed', 'deprecated'], default: 'active' },
          tags: { type: 'array', items: { type: 'string' } },
          links: {
            type: 'array',
            description: 'Code nodes to link to',
            items: {
              type: 'object',
              properties: {
                cbm_node_id: { type: 'number' },
                edge_type: {
                  type: 'string',
                  enum: ['EXPLAINS', 'DECIDES', 'AFFECTS', 'TOUCHES', 'DOCUMENTS', 'DEPRECATES', 'REPLACES', 'RISKS', 'MENTIONS', 'JUSTIFIES', 'OWNS', 'TODO_FOR'],
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
    const project = this.optionalString(args, 'project') ?? this.project;
    const label = this.requireString(args, 'label') as HumanNodeLabel;
    const title = this.requireString(args, 'title');
    const bodyMarkdown = this.optionalString(args, 'body_markdown') ?? '';
    const status = (this.optionalString(args, 'status') ?? 'active') as any;
    const tags = (this.optionalArray(args, 'tags') ?? []) as string[];
    const links = (this.optionalArray(args, 'links') ?? []) as Array<{ cbm_node_id: number; edge_type: HumanEdgeType }>;
    const author = this.optionalString(args, 'author');

    try {
      const cbmNodeIds = links.map((l) => l.cbm_node_id);

      const node = this.humanStore.createNode({
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

      // Create edges
      const createdEdges: Array<{ id: number; type: HumanEdgeType; cbm_node_id: number }> = [];
      for (const link of links) {
        const edge = this.humanStore.createEdge({
          project,
          source_human_node_id: node.id,
          target_kind: 'code',
          target_cbm_node_id: link.cbm_node_id,
          type: link.edge_type,
        });
        createdEdges.push({ id: edge.id, type: link.edge_type, cbm_node_id: link.cbm_node_id });
      }

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
    } catch (e: any) {
      return this.error(e.message);
    }
  }
}
