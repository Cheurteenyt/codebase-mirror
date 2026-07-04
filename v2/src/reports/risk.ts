// v2/src/reports/risk.ts
// Report: high coupling, dead code, fragile interfaces.

import { CodeGraphReader } from '../bridge/sqlite-ro.js';
import { HumanMemoryStore } from '../human/store.js';

export interface RiskItem {
  cbm_node_id: number;
  label: string;
  name: string;
  file_path: string;
  issue: 'high_coupling' | 'dead_code_candidate' | 'fragile_interface' | 'central_function' | 'no_documentation';
  details: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface RiskReport {
  project: string;
  generated_at: string;
  total_items: number;
  by_severity: Record<string, number>;
  by_issue: Record<string, number>;
  items: RiskItem[];
}

export function computeRiskReport(
  project: string,
  codeReader: CodeGraphReader,
  humanStore: HumanMemoryStore,
  opts: { limit?: number } = {}
): RiskReport {
  const limit = opts.limit ?? 200;
  const items: RiskItem[] = [];

  // 1. High coupling — modules with degree >= 40
  const modules = codeReader.listModules(project, 5000);
  for (const m of modules) {
    const degree = codeReader.getNodeDegree(m.id);
    if (degree >= 40) {
      const severity = degree >= 80 ? 'critical' : degree >= 60 ? 'high' : 'medium';
      items.push({
        cbm_node_id: m.id,
        label: m.label,
        name: m.name,
        file_path: m.file_path,
        issue: 'high_coupling',
        details: `Module has degree ${degree} (≥40 = high coupling threshold)`,
        severity,
      });
    }
  }

  // 2. Dead code candidates — functions with degree = 0 (no callers)
  const functions = codeReader.listNodes(project, { label: 'Function', limit: 5000 });
  for (const f of functions) {
    const degree = codeReader.getNodeDegree(f.id);
    if (degree === 0) {
      const props = JSON.parse(f.properties_json || '{}');
      if (props.is_exported) continue; // exported functions are likely API surface
      if (props.is_test) continue;     // tests are called by test runner
      items.push({
        cbm_node_id: f.id,
        label: f.label,
        name: f.name,
        file_path: f.file_path,
        issue: 'dead_code_candidate',
        details: 'Function has no callers and is not exported (potential dead code)',
        severity: 'low',
      });
    }
  }

  // 3. Fragile interfaces — interfaces used by many implementations
  const interfaces = codeReader.listNodes(project, { label: 'Interface', limit: 5000 });
  for (const i of interfaces) {
    const degree = codeReader.getNodeDegree(i.id);
    if (degree >= 10) {
      const severity = degree >= 30 ? 'high' : 'medium';
      items.push({
        cbm_node_id: i.id,
        label: i.label,
        name: i.name,
        file_path: i.file_path,
        issue: 'fragile_interface',
        details: `Interface has degree ${degree} — modifying it affects many callers`,
        severity,
      });
    }
  }

  // 4. Central functions — functions with degree >= 20
  for (const f of functions) {
    const degree = codeReader.getNodeDegree(f.id);
    if (degree >= 20) {
      const severity = degree >= 50 ? 'critical' : degree >= 30 ? 'high' : 'medium';
      items.push({
        cbm_node_id: f.id,
        label: f.label,
        name: f.name,
        file_path: f.file_path,
        issue: 'central_function',
        details: `Function has degree ${degree} (central node)`,
        severity,
      });
    }
  }

  // 5. Critical nodes without documentation
  for (const m of modules) {
    const degree = codeReader.getNodeDegree(m.id);
    if (degree >= 30) {
      const notes = humanStore.listNodesByCbmNodeId(project, m.id, 1);
      if (notes.length === 0) {
        items.push({
          cbm_node_id: m.id,
          label: m.label,
          name: m.name,
          file_path: m.file_path,
          issue: 'no_documentation',
          details: `Module with degree ${degree} has no human notes`,
          severity: 'high',
        });
      }
    }
  }

  // Sort by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  items.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  const top = items.slice(0, limit);

  const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const byIssue: Record<string, number> = {};
  for (const item of top) {
    bySeverity[item.severity]++;
    byIssue[item.issue] = (byIssue[item.issue] || 0) + 1;
  }

  return {
    project,
    generated_at: new Date().toISOString(),
    total_items: top.length,
    by_severity: bySeverity,
    by_issue: byIssue,
    items: top,
  };
}

export function renderRiskReportMarkdown(report: RiskReport): string {
  const lines: string[] = [];
  lines.push(`# Risk Report — ${report.project}`);
  lines.push('');
  lines.push(`> Généré le ${report.generated_at}`);
  lines.push('');
  lines.push('## Synthèse');
  lines.push('');
  lines.push('| Métrique | Valeur |');
  lines.push('|---|---|');
  lines.push(`| Total items | ${report.total_items} |`);
  lines.push(`| Critique | ${report.by_severity.critical} |`);
  lines.push(`| Haut | ${report.by_severity.high} |`);
  lines.push(`| Moyen | ${report.by_severity.medium} |`);
  lines.push(`| Bas | ${report.by_severity.low} |`);
  lines.push('');
  lines.push('## Par type d\'issue');
  lines.push('');
  lines.push('| Issue | Nombre |');
  lines.push('|---|---|');
  for (const [issue, count] of Object.entries(report.by_issue)) {
    lines.push(`| ${issue} | ${count} |`);
  }
  lines.push('');
  lines.push('## Items (top 200)');
  lines.push('');
  lines.push('| Sévérité | Issue | Label | Name | Fichier | Détails |');
  lines.push('|---|---|---|---|---|---|');
  for (const item of report.items) {
    lines.push(
      `| ${item.severity} | ${item.issue} | ${item.label} | ${item.name} | \`${item.file_path}\` | ${item.details} |`
    );
  }
  return lines.join('\n');
}
