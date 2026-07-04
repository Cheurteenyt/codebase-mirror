// v2/src/reports/risk.ts
// Report: high coupling, dead code, fragile interfaces, central functions.
// Also exports the shared computeRiskScore function used by other modules.

import { CodeGraphReader } from '../bridge/sqlite-ro.js';
import { HumanMemoryStore } from '../human/store.js';
import { safeJsonParse, MAX_NODES_PER_LABEL } from '../constants.js';

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
  total_items_found: number;       // total before slicing
  total_items_returned: number;    // after slicing to `limit`
  by_severity: Record<string, number>;
  by_issue: Record<string, number>;
  items: RiskItem[];
}

/**
 * Compute a risk score in [0, 1] from degree, complexity, and documentation status.
 * Shared formula — used by reports/hotspots.ts, mcp/tools/get_module_context.ts,
 * mcp/tools/get_project_overview.ts.
 *
 * Formula:
 *   degreeScore = min(degree / 100, 1.0)         // high coupling → high risk
 *   complexityScore = min(complexity / 20, 1.0)  // high complexity → high risk
 *   documentationPenalty = notesCount > 0 ? 0 : 0.2  // undocumented → +0.2
 *   riskScore = min(degreeScore * 0.5 + complexityScore * 0.3 + documentationPenalty, 1.0)
 */
export function computeRiskScore(degree: number, complexity: number, notesCount: number): number {
  const degreeScore = Math.min(degree / 100, 1.0);
  const complexityScore = Math.min(complexity / 20, 1.0);
  const documentationPenalty = notesCount > 0 ? 0 : 0.2;
  return Math.min(degreeScore * 0.5 + complexityScore * 0.3 + documentationPenalty, 1.0);
}

export function computeRiskReport(
  project: string,
  codeReader: CodeGraphReader,
  humanStore: HumanMemoryStore,
  opts: { limit?: number } = {}
): RiskReport {
  const limit = opts.limit ?? 200;
  const items: RiskItem[] = [];

  // Fetch all modules, functions, interfaces in bulk.
  const modules = codeReader.listModules(project, MAX_NODES_PER_LABEL);
  const functions = codeReader.listNodes(project, { label: 'Function', limit: MAX_NODES_PER_LABEL });
  const interfaces = codeReader.listNodes(project, { label: 'Interface', limit: MAX_NODES_PER_LABEL });

  // Bulk-fetch degrees to avoid N+1.
  const allIds = [...modules, ...functions, ...interfaces].map((n) => n.id);
  const degreeMap = codeReader.getBulkNodeDegrees(allIds);

  // 1. High coupling — modules with degree >= 40.
  for (const m of modules) {
    const degree = degreeMap.get(m.id) ?? 0;
    if (degree >= 40) {
      const severity = degree >= 80 ? 'critical' : degree >= 60 ? 'high' : 'medium';
      items.push({
        cbm_node_id: m.id,
        label: m.label,
        name: m.name,
        file_path: m.file_path,
        issue: 'high_coupling',
        details: `Module has degree ${degree} (>= 40 = high coupling threshold)`,
        severity,
      });
    }
  }

  // 2. Dead code candidates — functions with degree = 0 (no callers).
  for (const f of functions) {
    const degree = degreeMap.get(f.id) ?? 0;
    if (degree === 0) {
      const props = safeJsonParse(f.properties_json, {} as Record<string, any>);
      if (props.is_exported) continue;
      if (props.is_test) continue;
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

  // 3. Fragile interfaces — interfaces used by many implementations.
  for (const i of interfaces) {
    const degree = degreeMap.get(i.id) ?? 0;
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

  // 4. Central functions — functions with degree >= 20.
  for (const f of functions) {
    const degree = degreeMap.get(f.id) ?? 0;
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

  // 5. Critical modules without documentation.
  for (const m of modules) {
    const degree = degreeMap.get(m.id) ?? 0;
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

  // Sort by severity.
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
    total_items_found: items.length,
    total_items_returned: top.length,
    by_severity: bySeverity,
    by_issue: byIssue,
    items: top,
  };
}

export function renderRiskReportMarkdown(report: RiskReport): string {
  const lines: string[] = [];
  lines.push(`# Risk Report — ${report.project}`);
  lines.push('');
  lines.push(`> Generated on ${report.generated_at}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Total items found | ${report.total_items_found} |`);
  lines.push(`| Total items returned | ${report.total_items_returned} |`);
  lines.push(`| Critical | ${report.by_severity.critical} |`);
  lines.push(`| High | ${report.by_severity.high} |`);
  lines.push(`| Medium | ${report.by_severity.medium} |`);
  lines.push(`| Low | ${report.by_severity.low} |`);
  lines.push('');
  lines.push('## By issue type');
  lines.push('');
  lines.push('| Issue | Count |');
  lines.push('|---|---|');
  for (const [issue, count] of Object.entries(report.by_issue)) {
    lines.push(`| ${issue} | ${count} |`);
  }
  lines.push('');
  lines.push(`## Items (top ${report.total_items_returned})`);
  lines.push('');
  lines.push('| Severity | Issue | Label | Name | File | Details |');
  lines.push('|---|---|---|---|---|---|');
  for (const item of report.items) {
    // Escape pipe characters in fields to keep the table valid.
    const esc = (s: string) => String(s).replace(/\|/g, '\\|');
    lines.push(
      `| ${item.severity} | ${esc(item.issue)} | ${esc(item.label)} | ${esc(item.name)} | \`${esc(item.file_path)}\` | ${esc(item.details)} |`
    );
  }
  return lines.join('\n');
}
