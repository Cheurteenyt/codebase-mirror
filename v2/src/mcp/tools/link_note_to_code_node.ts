// v2/src/mcp/tools/link_note_to_code_node.ts

import { BaseTool } from './base.js';
import { ToolDefinition } from './index.js';
import { HumanEdgeType } from '../../human/schema.js';

export class LinkNoteToCodeNodeTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'link_note_to_code_node',
      description: 'Create an edge between an existing human note and a code node (or another human node). Useful when a note already exists and you want to attach it to additional code symbols.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          human_note_id: { type: 'number', description: 'ID of the human note (source)' },
          target_kind: { type: 'string', enum: ['code', 'human'] },
          target_cbm_node_id: { type: 'number', description: 'Required if target_kind = "code"' },
          target_human_node_id: { type: 'number', description: 'Required if target_kind = "human"' },
          edge_type: {
            type: 'string',
            enum: ['EXPLAINS', 'DECIDES', 'AFFECTS', 'TOUCHES', 'DOCUMENTS', 'DEPRECATES', 'REPLACES', 'RISKS', 'MENTIONS', 'JUSTIFIES', 'OWNS', 'TODO_FOR'],
          },
          properties: { type: 'object', description: 'Optional metadata for the edge' },
        },
        required: ['human_note_id', 'target_kind', 'edge_type'],
        additionalProperties: false,
      },
      handler: LinkNoteToCodeNodeTool,
    };
  }

  async handle(args: Record<string, unknown>) {
    const project = this.optionalString(args, 'project') ?? this.project;
    const humanNoteId = this.optionalNumber(args, 'human_note_id');
    const targetKind = this.optionalString(args, 'target_kind') as 'code' | 'human' | undefined;
    const targetCbmNodeId = this.optionalNumber(args, 'target_cbm_node_id');
    const targetHumanNodeId = this.optionalNumber(args, 'target_human_node_id');
    const edgeType = this.optionalString(args, 'edge_type') as HumanEdgeType | undefined;
    const properties = args.properties as Record<string, unknown> | undefined;

    if (humanNoteId == null) return this.error('human_note_id is required');
    if (!targetKind) return this.error('target_kind is required');
    if (!edgeType) return this.error('edge_type is required');

    try {
      // Verify the source node exists
      const source = this.humanStore.getNodeById(humanNoteId);
      if (!source) {
        return this.error(`Human note with id ${humanNoteId} not found`);
      }
      if (source.project !== project) {
        return this.error(`Human note ${humanNoteId} belongs to project "${source.project}", not "${project}"`);
      }

      const edge = this.humanStore.createEdge({
        project,
        source_human_node_id: humanNoteId,
        target_kind: targetKind,
        target_cbm_node_id: targetKind === 'code' ? targetCbmNodeId : null,
        target_human_node_id: targetKind === 'human' ? targetHumanNodeId : null,
        type: edgeType,
        properties: properties as Record<string, unknown> | undefined,
      });

      return this.json({
        success: true,
        edge: {
          id: edge.id,
          source_human_node_id: edge.source_human_node_id,
          target_kind: edge.target_kind,
          target_cbm_node_id: edge.target_cbm_node_id,
          target_human_node_id: edge.target_human_node_id,
          type: edge.type,
          created_at: edge.created_at,
        },
      });
    } catch (e: any) {
      return this.error(e.message);
    }
  }
}
