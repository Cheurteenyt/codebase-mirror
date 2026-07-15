// v2/src/mcp/tools/get_project_overview.ts

import { BaseTool } from './base.js';
import { ToolDefinition } from './index.js';
import { MAX_NODES_PER_LABEL } from '../../constants.js';
import { getGraphStatus, getFreshnessScore, freshnessLabel } from '../../intelligence/graph-status.js';

export class GetProjectOverviewTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'get_project_overview',
      description: 'Get a high-level overview of a project: counts of code nodes, human notes, ADRs, bugs, refactors, hotspots, and documentation coverage. Useful as the first call when an agent starts exploring a codebase.',
      annotations: {
        title: 'Get project overview',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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

      // R39: use countNodesByLabel (1 GROUP BY query instead of 4 COUNT queries).
      const labelCounts = humanStore.countNodesByLabel(project);
      const activeLabelCounts = humanStore.countActiveNodesByLabel(project);
      const humanEdgesCount = humanStore.countEdges(project);

      result['human_memory'] = {
        total_notes: labelCounts['_total'] ?? 0,
        adrs: labelCounts['ADR'] ?? 0,
        // Historical totals are retained for API compatibility. Explicit
        // active fields drive open/pending recommendations below.
        bugs: labelCounts['BugNote'] ?? 0,
        active_bugs: activeLabelCounts['BugNote'] ?? 0,
        refactors: labelCounts['RefactorPlan'] ?? 0,
        active_refactors: activeLabelCounts['RefactorPlan'] ?? 0,
        human_edges: humanEdgesCount,
      };

      // Compute documentation coverage for critical modules only (degree >= 20).
      // Returns null when there are no critical modules (rather than misleading "100%").
      if (codeReader) {
        const moduleProbe = codeReader.listModules(project, MAX_NODES_PER_LABEL + 1);
        const moduleScanTruncated = moduleProbe.length > MAX_NODES_PER_LABEL;
        const modules = moduleProbe.slice(0, MAX_NODES_PER_LABEL);
        const moduleIds = modules.map((m) => m.id);
        const degreeMap = codeReader.getBulkNodeDegrees(moduleIds);
        // R15: bulk-fetch notes for ALL modules once, then filter by criticality.
        // Previously called listNodesByCbmNodeId per critical module — N+1 pattern.
        const notesByNode = humanStore.getBulkNotesByCbmNodeIds(project, moduleIds, 1);
        let criticalTotal = 0;
        let criticalDocumented = 0;
        for (const m of modules) {
          const deg = degreeMap.get(m.id) ?? 0;
          if (deg >= 20) {
            criticalTotal++;
            const notes = notesByNode.get(m.id) ?? [];
            if (notes.length > 0) criticalDocumented++;
          }
        }
        result['documentation_coverage'] = {
          critical_modules_total: criticalTotal,
          critical_modules_documented: criticalDocumented,
          coverage_pct: criticalTotal > 0 ? (criticalDocumented / criticalTotal) * 100 : null,
          scanned_modules: modules.length,
          module_scan_limit: MAX_NODES_PER_LABEL,
          scan_truncated: moduleScanTruncated,
          critical_counts_are_lower_bounds: moduleScanTruncated,
          coverage_is_partial: moduleScanTruncated,
        };
      }

      // Graph freshness status — the agent MUST know if data is stale.
      if (codeReader) {
        const graphStatus = getGraphStatus(
          project,
          codeReader,
          codeReader.getProjectRoot(project) ?? process.cwd(),
        );
        const freshnessScore = getFreshnessScore(graphStatus);
        result['graph_status'] = {
          available: graphStatus.available,
          last_indexed: graphStatus.last_indexed,
          age_seconds: graphStatus.age_seconds,
          stale: graphStatus.stale,
          stale_reason: graphStatus.stale_reason,
          stale_files_count: graphStatus.stale_files_count,
          stale_files_sample: graphStatus.stale_files_sample,
          freshness_score: freshnessScore,
          freshness_label: freshnessLabel(freshnessScore),
          recommendation: graphStatus.recommendation,
        };
      }

      // Smart recommendations — the agent gets actionable next steps.
      const recommendations: string[] = [];
      const graphStatus = result['graph_status'] as any;
      if (graphStatus?.stale) {
        recommendations.push(`Refresh the code graph: ${graphStatus.stale_reason}. Run "cbm-v2 index --project <name> --root <path>".`);
      }
      if ((activeLabelCounts['BugNote'] ?? 0) > 0) {
        recommendations.push(`${activeLabelCounts['BugNote']} open bug(s) — review before making changes. Use prepare_edit_context to see affected files.`);
      }
      if ((activeLabelCounts['RefactorPlan'] ?? 0) > 0) {
        recommendations.push(`${activeLabelCounts['RefactorPlan']} pending refactor plan(s) — check if your work overlaps. Use get_module_context to see details.`);
      }
      const docCoverage = result['documentation_coverage'] as any;
      if (docCoverage?.scan_truncated) {
        recommendations.push(`Documentation coverage is partial: only the first ${docCoverage.scanned_modules} modules were scanned. Critical-module counts are lower bounds.`);
      }
      if (docCoverage && docCoverage.coverage_pct !== null && docCoverage.coverage_pct < 50) {
        const qualifier = docCoverage.critical_counts_are_lower_bounds ? 'at least ' : '';
        recommendations.push(`Documentation coverage is ${docCoverage.coverage_pct.toFixed(0)}% — ${qualifier}${docCoverage.critical_modules_total - docCoverage.critical_modules_documented} critical module(s) undocumented. Use get_undocumented_hotspots to identify them.`);
      }
      if (recommendations.length === 0) {
        recommendations.push('Project is in good shape. Use prepare_edit_context before modifying any file to get full context.');
      }
      result['recommendations'] = recommendations;

      return this.json(result);
    } catch (e: unknown) {
      return this.error((e instanceof Error ? e.message : String(e)));
    }
  }
}
