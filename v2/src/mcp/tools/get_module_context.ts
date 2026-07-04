// v2/src/mcp/tools/get_module_context.ts

import { BaseTool } from './base.js';
import { ToolDefinition } from './index.js';

export class GetModuleContextTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'get_module_context',
      description: 'Get the full context of a module: code structure (functions, dependencies, neighbors) AND human memory (notes, ADRs, bugs, refactors linked to it). The flagship V2 tool for agents — single call returns everything needed to understand a module.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          module_name: { type: 'string', description: 'Module name (case-insensitive substring match)' },
          include_code: { type: 'boolean', default: true },
          include_human: { type: 'boolean', default: true },
          include_adrs: { type: 'boolean', default: true },
          include_bugs: { type: 'boolean', default: true },
          include_refactors: { type: 'boolean', default: true },
          depth: { type: 'number', default: 2, description: 'BFS depth for neighbors' },
          max_nodes: { type: 'number', default: 200 },
        },
        required: ['module_name'],
        additionalProperties: false,
      },
      handler: GetModuleContextTool,
    };
  }

  async handle(args: Record<string, unknown>) {
    const project = this.optionalString(args, 'project') ?? this.project;
    const moduleName = this.requireString(args, 'module_name');
    const includeCode = args.include_code !== false;
    const includeHuman = args.include_human !== false;
    const includeAdrs = args.include_adrs !== false;
    const includeBugs = args.include_bugs !== false;
    const includeRefactors = args.include_refactors !== false;
    const maxNodes = this.optionalNumber(args, 'max_nodes') ?? 200;

    try {
      const codeReader = this.codeReader;
      if (!codeReader) {
        return this.error('Code graph reader not configured');
      }

      // Find module by name
      const modules = codeReader.findModulesByName(project, moduleName, 10);
      if (modules.length === 0) {
        return this.error(`No module found matching "${moduleName}" in project "${project}"`);
      }
      const module = modules[0];
      const degree = codeReader.getNodeDegree(module.id);
      const props = JSON.parse(module.properties_json || '{}');

      const result: Record<string, unknown> = {
        module: {
          cbm_node_id: module.id,
          name: module.name,
          qualified_name: module.qualified_name,
          file_path: module.file_path,
          label: module.label,
          degree,
          properties: props,
        },
      };

      if (includeCode) {
        const neighbors = codeReader.getNeighbors(module.id, 'both', maxNodes);
        result['code_nodes'] = neighbors.slice(0, maxNodes).map(({ edge, node }) => ({
          id: node.id,
          label: node.label,
          name: node.name,
          file_path: node.file_path,
          edge_type: edge.type,
          edge_direction: edge.source_id === module.id ? 'out' : 'in',
        }));
        result['code_stats'] = {
          neighbors_count: neighbors.length,
          truncated: neighbors.length === maxNodes,
        };
      }

      if (includeHuman) {
        const humanNotes = this.humanStore.listNodesByCbmNodeId(project, module.id);
        result['human_notes'] = humanNotes.map((n) => ({
          id: n.id,
          label: n.label,
          title: n.title,
          status: n.status,
          tags: n.tags,
          updated_at: n.updated_at,
          obsidian_path: n.obsidian_path,
          body_excerpt: n.body_markdown.slice(0, 500),
        }));

        if (includeAdrs) {
          const adrs = humanNotes.filter((n) => n.label === 'ADR');
          result['adrs'] = adrs.map((n) => ({
            id: n.id,
            title: n.title,
            status: n.status,
            updated_at: n.updated_at,
            body_excerpt: n.body_markdown.slice(0, 500),
          }));
        }

        if (includeBugs) {
          const bugs = humanNotes.filter((n) => n.label === 'BugNote');
          result['bugs'] = bugs.map((n) => ({
            id: n.id,
            title: n.title,
            status: n.status,
            body_excerpt: n.body_markdown.slice(0, 500),
          }));
        }

        if (includeRefactors) {
          const refactors = humanNotes.filter((n) => n.label === 'RefactorPlan');
          result['refactors'] = refactors.map((n) => ({
            id: n.id,
            title: n.title,
            status: n.status,
            body_excerpt: n.body_markdown.slice(0, 500),
          }));
        }
      }

      // Compute risk score
      const degreeScore = Math.min(degree / 100, 1.0);
      const complexityScore = Math.min((props.complexity_avg ?? props.complexity ?? 0) / 20, 1.0);
      const notesCount = this.humanStore.listNodesByCbmNodeId(project, module.id, 1).length;
      const documentationPenalty = notesCount > 0 ? 0 : 0.2;
      const riskScore = Math.min(degreeScore * 0.5 + complexityScore * 0.3 + documentationPenalty, 1.0);

      result['stats'] = {
        documentation_coverage: notesCount > 0 ? 1.0 : 0.0,
        risk_score: riskScore,
        risk_level: riskScore >= 0.7 ? 'high' : riskScore >= 0.4 ? 'medium' : 'low',
      };

      return this.json(result);
    } catch (e: any) {
      return this.error(e.message);
    }
  }
}
