// v2/src/mcp/tools/link_note_to_code_node.ts

import { BaseTool } from './base.js';
import { ToolDefinition } from './index.js';
import { HUMAN_EDGE_TYPES } from '../../human/schema.js';

export class LinkNoteToCodeNodeTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'link_note_to_code_node',
      description: 'Create an edge between an existing human note and a code node (or another human node). Useful when a note already exists and you want to attach it to additional code symbols. Validates that both source note and target code node exist.',
      annotations: {
        title: 'Link note to code node',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
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
            enum: HUMAN_EDGE_TYPES as readonly string[],
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
    try {
      const project = this.optionalString(args, 'project') ?? this.project;
      const humanNoteId = this.requireNumber(args, 'human_note_id');
      const targetKind = this.requireEnum(args, 'target_kind', ['code', 'human'] as const);
      const edgeType = this.requireEnum(args, 'edge_type', HUMAN_EDGE_TYPES);
      const properties = args.properties as Record<string, unknown> | undefined;

      let targetCbmNodeId: number | undefined;
      let targetHumanNodeId: number | undefined;
      if (targetKind === 'code') {
        targetCbmNodeId = this.requireNumber(args, 'target_cbm_node_id');
      } else {
        targetHumanNodeId = this.requireNumber(args, 'target_human_node_id');
      }
      // Verify the source node exists and belongs to the project.
      const source = this.humanStore.getNodeById(humanNoteId);
      if (!source) {
        return this.error(`Human note with id=${humanNoteId} not found.`);
      }
      if (source.project !== project) {
        return this.error(`Human note ${humanNoteId} belongs to project "${source.project}", not "${project}".`);
      }

      // For code targets, verify the code node exists (if reader is available).
      if (targetKind === 'code' && this.codeReader) {
        const codeNode = this.codeReader.getNodeById(targetCbmNodeId!);
        if (!codeNode) {
          return this.error(
            `Code node with id=${targetCbmNodeId} not found in project "${project}". ` +
            `Verify the ID with search_code_and_memory, or note that re-indexing can change IDs.`
          );
        }
      }

      // For human targets, verify the target node exists.
      if (targetKind === 'human') {
        const target = this.humanStore.getNodeById(targetHumanNodeId!);
        if (!target) {
          return this.error(`Target human note with id=${targetHumanNodeId} not found.`);
        }
      }

      const edge = this.humanStore.createEdge({
        project,
        source_human_node_id: humanNoteId,
        target_kind: targetKind,
        target_cbm_node_id: targetKind === 'code' ? targetCbmNodeId! : null,
        target_human_node_id: targetKind === 'human' ? targetHumanNodeId! : null,
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
    } catch (e: unknown) {
      return this.error((e instanceof Error ? e.message : String(e)));
    }
  }
}
