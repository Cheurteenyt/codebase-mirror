// v2/src/reports/hotspots.ts
// Report: critical modules (high degree + high complexity).

import { CodeGraphReader } from '../bridge/sqlite-ro.js';
import { HumanMemoryStore } from '../human/store.js';
import { computeRiskScore } from './risk.js';
import { safeJsonParse, MAX_NODES_PER_LABEL } from '../constants.js';
import { escapeMarkdownTableCell } from './markdown.js';

export interface Hotspot {
  cbm_node_id: number;
  name: string;
  qualified_name: string;
  file_path: string;
  label: string;
  degree: number;
  complexity_avg: number;
  notes_count: number;
  is_documented: boolean;
  risk_score: number;        // 0.0-1.0
}

export interface HotspotsReport {
  project: string;
  generated_at: string;
  total_modules: number;       // exact count from countNodesByLabel
  hotspots: Hotspot[];
  summary: {
    critical: number;          // degree >= 50
    high: number;              // degree 30-49
    medium: number;            // degree 20-29
    documented: number;
    undocumented: number;
  };
}

export function computeHotspotsReport(
  project: string,
  codeReader: CodeGraphReader,
  humanStore: HumanMemoryStore,
  opts: { minDegree?: number; limit?: number } = {}
): HotspotsReport {
  const minDegree = opts.minDegree ?? 20;
  const limit = opts.limit ?? 100;

  const modules = codeReader.listModules(project, MAX_NODES_PER_LABEL);

  // Bulk-fetch degrees to avoid N+1.
  const moduleIds = modules.map((m) => m.id);
  const degreeMap = codeReader.getBulkNodeDegrees(moduleIds);
  // R47 (M3): fetch up to 200 notes per module so notes_count is accurate.
  // The old limit=1 capped notes_count at 1 even when 10 notes were linked.
  const notesMap = humanStore.getBulkNotesByCbmNodeIds(project, moduleIds, 200);

  // Get exact total module count (don't rely on `modules.length` which caps at MAX_NODES_PER_LABEL).
  const labelCounts = codeReader.countNodesByLabel(project);
  const totalModulesExact = labelCounts['Module'] ?? modules.length;

  const hotspots: Hotspot[] = [];

  for (const module of modules) {
    const degree = degreeMap.get(module.id) ?? 0;
    if (degree < minDegree) continue;

    const props = safeJsonParse(module.properties_json, {} as Record<string, any>);
    const complexityAvg = props.complexity_avg ?? props.complexity ?? 0;
    const notesCount = notesMap.get(module.id)?.length ?? 0;
    const riskScore = computeRiskScore(degree, complexityAvg, notesCount);

    hotspots.push({
      cbm_node_id: module.id,
      name: module.name,
      qualified_name: module.qualified_name,
      file_path: module.file_path,
      label: module.label,
      degree,
      complexity_avg: complexityAvg,
      notes_count: notesCount,
      is_documented: notesCount > 0,
      risk_score: riskScore,
    });
  }

  hotspots.sort((a, b) => b.risk_score - a.risk_score);
  const top = hotspots.slice(0, limit);

  const summary = {
    critical: top.filter((h) => h.degree >= 50).length,
    high: top.filter((h) => h.degree >= 30 && h.degree < 50).length,
    medium: top.filter((h) => h.degree >= 20 && h.degree < 30).length,
    documented: top.filter((h) => h.is_documented).length,
    undocumented: top.filter((h) => !h.is_documented).length,
  };

  return {
    project,
    generated_at: new Date().toISOString(),
    total_modules: totalModulesExact,
    hotspots: top,
    summary,
  };
}

export function renderHotspotsReportMarkdown(report: HotspotsReport): string {
  const lines: string[] = [];
  lines.push(`# Hotspots Report — ${report.project}`);
  lines.push('');
  lines.push(`> Generated on ${report.generated_at}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('|---|---|');
  lines.push(`| Total modules | ${report.total_modules} |`);
  lines.push(`| Critical (degree >= 50) | ${report.summary.critical} |`);
  lines.push(`| High (degree 30-49) | ${report.summary.high} |`);
  lines.push(`| Medium (degree 20-29) | ${report.summary.medium} |`);
  lines.push(`| Documented | ${report.summary.documented} |`);
  lines.push(`| Undocumented ⚠️ | ${report.summary.undocumented} |`);
  lines.push('');
  lines.push('## Top hotspots');
  lines.push('');
  lines.push('| Module | Degree | Complexity | Notes | Risk | Documented |');
  lines.push('|---|---|---|---|---|---|');
  for (const h of report.hotspots) {
    lines.push(
      `| ${escapeMarkdownTableCell(h.name)} | ${h.degree} | ${h.complexity_avg.toFixed(1)} | ${h.notes_count} | ${(h.risk_score * 100).toFixed(0)}% | ${h.is_documented ? '✅' : '❌'} |`
    );
  }
  return lines.join('\n');
}
