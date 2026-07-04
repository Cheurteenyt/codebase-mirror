// v2/src/reports/hotspots.ts
// Report: modules critiques (high degree + high complexity).

import { CodeGraphReader } from '../bridge/sqlite-ro.js';
import { HumanMemoryStore } from '../human/store.js';

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
  risk_score: number;        // 0.0-1.0, computed
}

export interface HotspotsReport {
  project: string;
  generated_at: string;
  total_modules: number;
  hotspots: Hotspot[];
  summary: {
    critical: number;        // degree >= 50
    high: number;            // degree 30-49
    medium: number;          // degree 20-29
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

  const modules = codeReader.listModules(project, 5000);
  const hotspots: Hotspot[] = [];

  for (const module of modules) {
    const degree = codeReader.getNodeDegree(module.id);
    if (degree < minDegree) continue;

    const props = JSON.parse(module.properties_json || '{}');
    const complexityAvg = props.complexity_avg ?? props.complexity ?? 0;
    const notesCount = humanStore.listNodesByCbmNodeId(project, module.id).length;

    // Risk score: weighted combination
    const degreeScore = Math.min(degree / 100, 1.0);
    const complexityScore = Math.min(complexityAvg / 20, 1.0);
    const documentationPenalty = notesCount > 0 ? 0 : 0.2;
    const riskScore = Math.min(degreeScore * 0.5 + complexityScore * 0.3 + documentationPenalty, 1.0);

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
    total_modules: modules.length,
    hotspots: top,
    summary,
  };
}

export function renderHotspotsReportMarkdown(report: HotspotsReport): string {
  const lines: string[] = [];
  lines.push(`# Hotspots Report — ${report.project}`);
  lines.push('');
  lines.push(`> Généré le ${report.generated_at}`);
  lines.push('');
  lines.push('## Synthèse');
  lines.push('');
  lines.push('| Catégorie | Nombre |');
  lines.push('|---|---|');
  lines.push(`| Modules totaux | ${report.total_modules} |`);
  lines.push(`| Critiques (degré ≥ 50) | ${report.summary.critical} |`);
  lines.push(`| Hauts (degré 30-49) | ${report.summary.high} |`);
  lines.push(`| Moyens (degré 20-29) | ${report.summary.medium} |`);
  lines.push(`| Documentés | ${report.summary.documented} |`);
  lines.push(`| Non documentés ⚠️ | ${report.summary.undocumented} |`);
  lines.push('');
  lines.push('## Top hotspots');
  lines.push('');
  lines.push('| Module | Degré | Complexité | Notes | Risk | Documenté |');
  lines.push('|---|---|---|---|---|---|');
  for (const h of report.hotspots) {
    lines.push(
      `| ${h.name} | ${h.degree} | ${h.complexity_avg.toFixed(1)} | ${h.notes_count} | ${(h.risk_score * 100).toFixed(0)}% | ${h.is_documented ? '✅' : '❌'} |`
    );
  }
  return lines.join('\n');
}
