// v2/src/reports/undocumented.ts
// Report: code nodes (modules, routes, functions) without human notes.

import { CodeGraphReader } from '../bridge/sqlite-ro.js';
import { HumanMemoryStore } from '../human/store.js';
import { safeJsonParse } from '../constants.js';

export interface UndocumentedNode {
  cbm_node_id: number;
  label: string;
  name: string;
  qualified_name: string;
  file_path: string;
  degree: number;
  complexity: number;
  is_critical: boolean;
}

export interface UndocumentedReport {
  project: string;
  generated_at: string;
  total_nodes: number;
  documented_nodes: number;
  undocumented_nodes: number;
  coverage_pct: number;
  by_label: Record<string, { total: number; documented: number; undocumented: number }>;
  undocumented_critical: UndocumentedNode[];
  undocumented_routes: UndocumentedNode[];
  undocumented_modules: UndocumentedNode[];
}

export function computeUndocumentedReport(
  project: string,
  codeReader: CodeGraphReader,
  humanStore: HumanMemoryStore
): UndocumentedReport {
  const labelsToCheck = ['Module', 'Route', 'Function', 'Class', 'Interface'];
  const byLabel: Record<string, { total: number; documented: number; undocumented: number }> = {};
  const undocumentedCritical: UndocumentedNode[] = [];
  const undocumentedRoutes: UndocumentedNode[] = [];
  const undocumentedModules: UndocumentedNode[] = [];

  let totalNodes = 0;
  let documentedNodes = 0;
  let undocumentedNodes = 0;

  for (const label of labelsToCheck) {
    byLabel[label] = { total: 0, documented: 0, undocumented: 0 };
    const nodes = codeReader.listNodes(project, { label, limit: 5000 });

    // Bulk-fetch degrees for all nodes of this label.
    const ids = nodes.map((n) => n.id);
    const degreeMap = codeReader.getBulkNodeDegrees(ids);

    for (const node of nodes) {
      byLabel[label].total++;
      totalNodes++;
      const degree = degreeMap.get(node.id) ?? 0;
      const props = safeJsonParse(node.properties_json, {} as Record<string, any>);
      const complexity = props.complexity ?? props.complexity_avg ?? 0;
      const notes = humanStore.listNodesByCbmNodeId(project, node.id, 1);

      if (notes.length > 0) {
        byLabel[label].documented++;
        documentedNodes++;
      } else {
        byLabel[label].undocumented++;
        undocumentedNodes++;

        const isCritical = degree >= 30 || complexity >= 10;
        const item: UndocumentedNode = {
          cbm_node_id: node.id,
          label: node.label,
          name: node.name,
          qualified_name: node.qualified_name,
          file_path: node.file_path,
          degree,
          complexity,
          is_critical: isCritical,
        };

        if (isCritical) undocumentedCritical.push(item);
        if (label === 'Route') undocumentedRoutes.push(item);
        if (label === 'Module') undocumentedModules.push(item);
      }
    }
  }

  undocumentedCritical.sort((a, b) => (b.degree + b.complexity) - (a.degree + a.complexity));
  undocumentedRoutes.sort((a, b) => b.degree - a.degree);
  undocumentedModules.sort((a, b) => b.degree - a.degree);

  return {
    project,
    generated_at: new Date().toISOString(),
    total_nodes: totalNodes,
    documented_nodes: documentedNodes,
    undocumented_nodes: undocumentedNodes,
    coverage_pct: totalNodes > 0 ? (documentedNodes / totalNodes) * 100 : 0,
    by_label: byLabel,
    undocumented_critical: undocumentedCritical.slice(0, 50),
    undocumented_routes: undocumentedRoutes.slice(0, 50),
    undocumented_modules: undocumentedModules.slice(0, 50),
  };
}

export function renderUndocumentedReportMarkdown(report: UndocumentedReport): string {
  const lines: string[] = [];
  lines.push(`# Undocumented Hotspots Report — ${report.project}`);
  lines.push('');
  lines.push(`> Generated on ${report.generated_at}`);
  lines.push('');
  lines.push('## Documentation coverage');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Total nodes | ${report.total_nodes} |`);
  lines.push(`| Documented | ${report.documented_nodes} |`);
  lines.push(`| Undocumented | ${report.undocumented_nodes} |`);
  lines.push(`| Coverage | ${report.coverage_pct.toFixed(1)} % |`);
  lines.push('');
  lines.push('## By label');
  lines.push('');
  lines.push('| Label | Total | Documented | Undocumented | Coverage |');
  lines.push('|---|---|---|---|---|');
  for (const [label, stats] of Object.entries(report.by_label)) {
    const coverage = stats.total > 0 ? (stats.documented / stats.total) * 100 : 0;
    lines.push(`| ${label} | ${stats.total} | ${stats.documented} | ${stats.undocumented} | ${coverage.toFixed(1)} % |`);
  }
  lines.push('');
  lines.push('## Undocumented critical modules');
  lines.push('');
  if (report.undocumented_modules.length === 0) {
    lines.push('✅ All modules are documented.');
  } else {
    lines.push('| Module | Degree | File |');
    lines.push('|---|---|---|');
    const esc = (s: string) => String(s).replace(/\|/g, '\\|');
    for (const m of report.undocumented_modules) {
      lines.push(`| ${esc(m.name)} | ${m.degree} | \`${esc(m.file_path)}\` |`);
    }
  }
  lines.push('');
  lines.push('## Undocumented routes');
  lines.push('');
  if (report.undocumented_routes.length === 0) {
    lines.push('✅ All routes are documented.');
  } else {
    lines.push('| Route | Degree | File |');
    lines.push('|---|---|---|');
    const esc = (s: string) => String(s).replace(/\|/g, '\\|');
    for (const r of report.undocumented_routes) {
      lines.push(`| ${esc(r.name)} | ${r.degree} | \`${esc(r.file_path)}\` |`);
    }
  }
  lines.push('');
  lines.push('## Top 50 undocumented critical nodes');
  lines.push('');
  if (report.undocumented_critical.length === 0) {
    lines.push('✅ No undocumented critical nodes.');
  } else {
    lines.push('| Label | Name | Degree | Complexity | File |');
    lines.push('|---|---|---|---|---|');
    const esc = (s: string) => String(s).replace(/\|/g, '\\|');
    for (const n of report.undocumented_critical) {
      lines.push(`| ${esc(n.label)} | ${esc(n.name)} | ${n.degree} | ${n.complexity} | \`${esc(n.file_path)}\` |`);
    }
  }
  return lines.join('\n');
}
