// v2/src/mcp/tools/get_undocumented_hotspots.ts

import { BaseTool } from './base.js';
import { ToolDefinition } from './index.js';
import { computeUndocumentedReport, type UndocumentedNode } from '../../reports/undocumented.js';

export class GetUndocumentedHotspotsTool extends BaseTool {
  get definition(): ToolDefinition {
    return {
      name: 'get_undocumented_hotspots',
      description: 'Find code nodes (modules, routes, functions, classes, interfaces) that are critical (high degree or complexity) but have NO human notes attached. Helps agents identify where documentation is most needed.',
      annotations: {
        title: 'Get undocumented hotspots',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          label: { type: 'string', enum: ['Module', 'Route', 'Function', 'Class', 'Interface'], description: 'Filter by code node label' },
          limit: { type: 'integer', minimum: 0, maximum: 200, default: 50 },
        },
        additionalProperties: false,
      },
      handler: GetUndocumentedHotspotsTool,
    };
  }

  async handle(args: Record<string, unknown>) {
    try {
      const project = this.optionalString(args, 'project') ?? this.project;
      // R46 (F8): validate label against the enum declared in the JSON Schema.
      // The old code used optionalString, which silently accepted invalid
      // values like "Bogus" — none of the if branches below matched, so the
      // tool returned an empty array with 200 OK, misleading the caller.
      // Now invalid labels get a clear error.
      const VALID_LABELS = ['Module', 'Route', 'Function', 'Class', 'Interface'] as const;
      const labelFilter = args.label == null
        ? undefined
        : this.requireEnum(args, 'label', VALID_LABELS);
      const limit = Math.max(0, Math.min(
        200,
        Math.floor(this.optionalNumber(args, 'limit') ?? 50),
      ));

      if (!this.codeReader) {
        return this.error('Code graph reader not configured. Index the project with V1 first.');
      }
      const report = computeUndocumentedReport(project, this.codeReader, this.humanStore);

      let items: UndocumentedNode[] = [];

      if (!labelFilter || labelFilter === 'Module') {
        items.push(...report.undocumented_modules);
      }
      if (!labelFilter || labelFilter === 'Route') {
        items.push(...report.undocumented_routes);
      }
      if (!labelFilter || labelFilter === 'Function' || labelFilter === 'Class' || labelFilter === 'Interface') {
        items.push(...report.undocumented_critical.filter((n) => !labelFilter || n.label === labelFilter));
      }

      items = [...new Map(items.map((item) => [item.cbm_node_id, item])).values()];
      items.sort((a, b) => (b.degree + b.complexity) - (a.degree + a.complexity));
      const top = items.slice(0, limit);
      const selectedLabels = labelFilter
        ? [labelFilter]
        : ['Module', 'Route', 'Function', 'Class', 'Interface'];
      const hotspotScanTruncated = selectedLabels.some(
        (label) => report.by_label[label]?.scan_truncated === true,
      );

      return this.json({
        project,
        generated_at: report.generated_at,
        summary: {
          total_nodes: report.total_nodes,
          documented: report.documented_nodes,
          undocumented: report.undocumented_nodes,
          coverage_pct: report.coverage_pct,
          scan_truncated: report.scan_truncated,
          counts_are_lower_bounds: report.counts_are_lower_bounds,
          coverage_is_partial: report.coverage_is_partial,
          scan_limit_per_label: report.scan_limit_per_label,
          truncated_labels: report.truncated_labels,
        },
        by_label: report.by_label,
        total_hotspots: items.length,
        total_hotspots_is_lower_bound: hotspotScanTruncated,
        returned_hotspots: top.length,
        truncated: top.length < items.length,
        undocumented_hotspots: top,
      });
    } catch (e: unknown) {
      return this.error((e instanceof Error ? e.message : String(e)));
    }
  }
}
