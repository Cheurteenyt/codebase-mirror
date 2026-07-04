// v2/src/mcp/tools/get_project_overview.ts

import { BaseTool } from './base.js';
import { ToolDefinition } from './index.js';
import { MAX_NODES_PER_LABEL } from '../../constants.js';

export class GetProjectOverviewTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'get_project_overview',
      description: 'Get a high-level overview of a project: counts of code nodes, human notes, ADRs, bugs, refactors, hotspots, and documentation coverage. Useful as the first call when an agent starts exploring a codebase.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Project name (defaults to the server\'s configured project)' },
        },
        additionalProperties: false,
      },
      handler: GetProjectOverviewTool,
    };
  }

  async handle(args: Record<string, unknown>) {
    try {
      const project = this.optionalString(args, 'project') ?? this.project;

      const humanStore = this.humanStore;
      const codeReader = this.codeReader;

      const result: Record<string, unknown> = {
        project,
        generated_at: new Date().toISOString(),
      };

      if (codeReader) {
        const nodeCount = codeReader.countNodes(project);
        const edgeCount = codeReader.countEdges(project);
        const nodesByLabel = codeReader.countNodesByLabel(project);
        const edgesByType = codeReader.countEdgesByType(project);
        result['code_graph'] = {
          total_nodes: nodeCount,
          total_edges: edgeCount,
          nodes_by_label: nodesByLabel,
          edges_by_type: edgesByType,
        };
      } else {
        result['code_graph'] = { available: false, reason: 'Code graph reader not configured. Index the project with V1 first.' };
      }

      const adrsCount = humanStore.countNodes(project, 'ADR');
      const bugsCount = humanStore.countNodes(project, 'BugNote');
      const refactorsCount = humanStore.countNodes(project, 'RefactorPlan');
      const notesTotal = humanStore.countNodes(project);
      const humanEdgesCount = humanStore.countEdges(project);

      result['human_memory'] = {
        total_notes: notesTotal,
        adrs: adrsCount,
        bugs: bugsCount,
        refactors: refactorsCount,
        human_edges: humanEdgesCount,
      };

      // Compute documentation coverage for critical modules only (degree >= 20).
      // Returns null when there are no critical modules (rather than misleading "100%").
      if (codeReader) {
        const modules = codeReader.listModules(project, MAX_NODES_PER_LABEL);
        const moduleIds = modules.map((m) => m.id);
        const degreeMap = codeReader.getBulkNodeDegrees(moduleIds);
        let criticalTotal = 0;
        let criticalDocumented = 0;
        for (const m of modules) {
          const deg = degreeMap.get(m.id) ?? 0;
          if (deg >= 20) {
            criticalTotal++;
            const notes = humanStore.listNodesByCbmNodeId(project, m.id, 1);
            if (notes.length > 0) criticalDocumented++;
          }
        }
        result['documentation_coverage'] = {
          critical_modules_total: criticalTotal,
          critical_modules_documented: criticalDocumented,
          coverage_pct: criticalTotal > 0 ? (criticalDocumented / criticalTotal) * 100 : null,
        };
      }

      return this.json(result);
    } catch (e: any) {
      return this.error(e.message);
    }
  }
}
