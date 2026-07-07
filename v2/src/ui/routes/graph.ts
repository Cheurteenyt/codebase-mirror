// v2/src/ui/routes/graph.ts
// R63: graph data routes — layout, dashboard, graph-status.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getGraphStatus, getFreshnessScore, freshnessLabel } from '../../intelligence/graph-status.js';
import { computeRiskScore } from '../../reports/risk.js';
import { safeJsonParse, MAX_NODES_PER_LABEL } from '../../constants.js';
import { sendJson, colorForLabel } from '../helpers.js';
import type { RouteContext } from '../types.js';

/**
 * GET /api/layout — graph layout data (2D, computed on-the-fly).
 * Returns nodes with positions + edges, capped at maxNodes (default 2000).
 */
export async function routeLayout(
  ctx: RouteContext,
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  project: string,
): Promise<void> {
  if (!ctx.codeReader) {
    sendJson(res, 404, { error: 'Code graph not available' });
    return;
  }
  // R20: clamp maxNodes to [1, 10000] to prevent DoS via negative limit.
  const rawMaxNodes = parseInt(url.searchParams.get('max_nodes') ?? '2000', 10);
  const maxNodes = Math.max(1, Math.min(10000, Number.isFinite(rawMaxNodes) ? rawMaxNodes : 2000));
  const nodes = ctx.codeReader.listNodes(project, { limit: maxNodes });
  const nodeIds = nodes.map((n) => n.id);
  const degreeMap = ctx.codeReader.getBulkNodeDegrees(nodeIds);

  const notesByNode = ctx.humanStore.getBulkNotesByCbmNodeIds(project, nodeIds, 1);
  const layoutNodes = nodes.map((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    const radius = 200 + (n.id % 100);
    const degree = degreeMap.get(n.id) ?? 0;
    const props = safeJsonParse(n.properties_json, {} as Record<string, unknown>);
    const complexity = Number(props.complexity_avg ?? props.complexity ?? 0);
    const notesCount = notesByNode.get(n.id)?.length ?? 0;
    const riskScore = computeRiskScore(degree, complexity, notesCount);

    return {
      id: n.id,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      label: n.label,
      name: n.name,
      file_path: n.file_path,
      qualified_name: n.qualified_name,
      start_line: n.start_line,
      end_line: n.end_line,
      size: Math.max(3, Math.min(12, Math.sqrt(degree) + 3)),
      color: colorForLabel(n.label),
      risk_score: riskScore,
      notes_count: notesCount,
    };
  });

  const edges = ctx.codeReader.getBulkEdges(nodeIds, 20);
  // R50 (#2): countNodes is ~1ms vs getGraphStatus 50-200ms.
  const totalNodes = ctx.codeReader.countNodes(project);

  sendJson(res, 200, {
    nodes: layoutNodes,
    edges,
    total_nodes: totalNodes,
  });
}

/**
 * GET /api/dashboard — project dashboard with graph status, human memory
 * counts, documentation coverage, and recommendations.
 */
export async function routeDashboard(
  ctx: RouteContext,
  _url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  project: string,
): Promise<void> {
  const graphStatus = getGraphStatus(project, ctx.codeReader, process.cwd());
  const freshnessScore = getFreshnessScore(graphStatus);

  const labelCounts = ctx.humanStore.countNodesByLabel(project);
  const adrs = labelCounts['ADR'] ?? 0;
  const bugs = labelCounts['BugNote'] ?? 0;
  const refactors = labelCounts['RefactorPlan'] ?? 0;
  const conventions = labelCounts['Convention'] ?? 0;
  const totalNotes = labelCounts['_total'] ?? 0;

  let criticalTotal = 0;
  let criticalDocumented = 0;
  if (ctx.codeReader) {
    const modules = ctx.codeReader.listModules(project, MAX_NODES_PER_LABEL);
    const moduleIds = modules.map((m) => m.id);
    const degreeMap = ctx.codeReader.getBulkNodeDegrees(moduleIds);
    const criticalIds = modules.filter(m => (degreeMap.get(m.id) ?? 0) >= 20).map(m => m.id);
    const notesByNode = ctx.humanStore.getBulkNotesByCbmNodeIds(project, criticalIds, 1);
    for (const m of modules) {
      if ((degreeMap.get(m.id) ?? 0) >= 20) criticalTotal++;
    }
    for (const id of criticalIds) {
      if ((notesByNode.get(id)?.length ?? 0) > 0) criticalDocumented++;
    }
  }

  const recommendations: string[] = [];
  if (graphStatus.stale) {
    recommendations.push(`Refresh code graph: ${graphStatus.stale_reason}. Run "cbm index_repository".`);
  }
  if (bugs > 0) {
    recommendations.push(`${bugs} open bug(s) — review before making changes.`);
  }
  if (refactors > 0) {
    recommendations.push(`${refactors} pending refactor plan(s) — check if your work overlaps.`);
  }
  if (criticalTotal > 0 && criticalDocumented < criticalTotal) {
    recommendations.push(`Documentation coverage is ${((criticalDocumented / criticalTotal) * 100).toFixed(0)}% — ${criticalTotal - criticalDocumented} critical module(s) undocumented.`);
  }
  if (recommendations.length === 0) {
    recommendations.push('Project is in good shape. Use prepare_edit_context before modifying any file.');
  }

  sendJson(res, 200, {
    project,
    generated_at: new Date().toISOString(),
    code_graph: ctx.codeReader
      ? {
          total_nodes: graphStatus.total_nodes,
          total_edges: graphStatus.total_edges,
          nodes_by_label: graphStatus.nodes_by_label,
        }
      : { total_nodes: 0, total_edges: 0, nodes_by_label: {} },
    human_memory: {
      total_notes: totalNotes,
      adrs,
      bugs,
      refactors,
      conventions,
    },
    documentation_coverage: {
      critical_modules_total: criticalTotal,
      critical_modules_documented: criticalDocumented,
      coverage_pct: criticalTotal > 0 ? (criticalDocumented / criticalTotal) * 100 : null,
    },
    graph_status: {
      ...graphStatus,
      freshness_score: freshnessScore,
      freshness_label: freshnessLabel(freshnessScore),
    },
    recommendations,
  });
}

/**
 * GET /api/graph-status — V2 graph freshness (stale check via git log).
 */
export async function routeGraphStatus(
  ctx: RouteContext,
  _url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  project: string,
): Promise<void> {
  const status = getGraphStatus(project, ctx.codeReader, process.cwd());
  const score = getFreshnessScore(status);
  sendJson(res, 200, {
    ...status,
    freshness_score: score,
    freshness_label: freshnessLabel(score),
  });
}
