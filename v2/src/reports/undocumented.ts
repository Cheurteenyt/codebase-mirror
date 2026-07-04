// v2/src/reports/undocumented.ts
// Report: code nodes (modules, routes, functions) without human notes.

import { CodeGraphReader } from '../bridge/sqlite-ro.js';
import { HumanMemoryStore } from '../human/store.js';

export interface UndocumentedNode {
  cbm_node_id: number;
  label: string;
  name: string;
  qualified_name: string;
  file_path: string;
  degree: number;
  complexity: number;
  is_critical: boolean;       // high degree or high complexity
}

export interface UndocumentedReport {
  project: string;
  generated_at: string;
  total_nodes: number;
  documented_nodes: number;
  undocumented_nodes: number;
  coverage_pct: number;
  by_label: Record<string, { total: number; documented: number; undocumented: number }>;
  undocumented_critical: UndocumentedNode[];   // top 50
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
    for (const node of nodes) {
      byLabel[label].total++;
      totalNodes++;
      const notes = humanStore.listNodesByCbmNodeId(project, node.id, 1);
      const degree = codeReader.getNodeDegree(node.id);
      const props = JSON.parse(node.properties_json || '{}');
      const complexity = props.complexity ?? props.complexity_avg ?? 0;

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
  lines.push(`> Généré le ${report.generated_at}`);
  lines.push('');
  lines.push('## Couverture documentation');
  lines.push('');
  lines.push('| Métrique | Valeur |');
  lines.push('|---|---|');
  lines.push(`| Nodes totaux | ${report.total_nodes} |`);
  lines.push(`| Documentés | ${report.documented_nodes} |`);
  lines.push(`| Non documentés | ${report.undocumented_nodes} |`);
  lines.push(`| Coverage | ${report.coverage_pct.toFixed(1)} % |`);
  lines.push('');
  lines.push('## Par label');
  lines.push('');
  lines.push('| Label | Total | Documentés | Non documentés | Coverage |');
  lines.push('|---|---|---|---|---|');
  for (const [label, stats] of Object.entries(report.by_label)) {
    const coverage = stats.total > 0 ? (stats.documented / stats.total) * 100 : 0;
    lines.push(`| ${label} | ${stats.total} | ${stats.documented} | ${stats.undocumented} | ${coverage.toFixed(1)} % |`);
  }
  lines.push('');
  lines.push('## Modules critiques non documentés');
  lines.push('');
  if (report.undocumented_modules.length === 0) {
    lines.push('✅ Tous les modules sont documentés.');
  } else {
    lines.push('| Module | Degré | Fichier |');
    lines.push('|---|---|---|');
    for (const m of report.undocumented_modules) {
      lines.push(`| ${m.name} | ${m.degree} | \`${m.file_path}\` |`);
    }
  }
  lines.push('');
  lines.push('## Routes non documentées');
  lines.push('');
  if (report.undocumented_routes.length === 0) {
    lines.push('✅ Toutes les routes sont documentées.');
  } else {
    lines.push('| Route | Degré | Fichier |');
    lines.push('|---|---|---|');
    for (const r of report.undocumented_routes) {
      lines.push(`| ${r.name} | ${r.degree} | \`${r.file_path}\` |`);
    }
  }
  lines.push('');
  lines.push('## Top 50 nodes critiques non documentés');
  lines.push('');
  if (report.undocumented_critical.length === 0) {
    lines.push('✅ Aucun node critique non documenté.');
  } else {
    lines.push('| Label | Name | Degré | Complexité | Fichier |');
    lines.push('|---|---|---|---|---|');
    for (const n of report.undocumented_critical) {
      lines.push(`| ${n.label} | ${n.name} | ${n.degree} | ${n.complexity} | \`${n.file_path}\` |`);
    }
  }
  return lines.join('\n');
}
