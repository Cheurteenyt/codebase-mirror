// v2/src/ui/routes/graph.ts
// R63: graph data routes — layout, dashboard, graph-status.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getGraphStatus, getFreshnessScore, freshnessLabel } from '../../intelligence/graph-status.js';
import { computeRiskScore } from '../../reports/risk.js';
import { safeJsonParse, MAX_NODES_PER_LABEL } from '../../constants.js';
import { sendJson, colorForLabel } from '../helpers.js';
import type { RouteContext } from '../types.js';

const STRUCTURAL_LABELS = new Set([
  'File', 'Module', 'Package', 'Namespace', 'Class', 'Interface', 'Trait', 'Enum',
]);
const CALLABLE_LABELS = new Set(['Function', 'Method', 'Constructor']);

function allocateBalancedLabelQuotas(
  counts: Record<string, number>,
  maxNodes: number,
): Map<string, number> {
  const labels = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([labelA, countA], [labelB, countB]) => countB - countA || labelA.localeCompare(labelB));
  const quotas = new Map<string, number>();
  if (labels.length === 0 || maxNodes <= 0) return quotas;

  // If there are more labels than slots, at least keep the most prevalent
  // labels deterministic. Otherwise every non-empty label receives a share.
  if (labels.length >= maxNodes) {
    for (const [label] of labels.slice(0, maxNodes)) quotas.set(label, 1);
    return quotas;
  }

  const equalShare = Math.max(1, Math.floor(maxNodes / labels.length));
  let allocated = 0;
  for (const [label, count] of labels) {
    const quota = Math.min(count, equalShare);
    quotas.set(label, quota);
    allocated += quota;
  }

  // Rare labels often leave unused slots. Redistribute them evenly across
  // labels that still have candidates, rather than letting one dominant label
  // consume the entire overview again.
  let remaining = maxNodes - allocated;
  while (remaining > 0) {
    const candidates = labels.filter(([label, count]) => (quotas.get(label) ?? 0) < count);
    if (candidates.length === 0) break;
    const share = Math.max(1, Math.floor(remaining / candidates.length));
    let added = 0;
    for (const [label, count] of candidates) {
      if (remaining === 0) break;
      const current = quotas.get(label) ?? 0;
      const take = Math.min(count - current, share, remaining);
      if (take <= 0) continue;
      quotas.set(label, current + take);
      remaining -= take;
      added += take;
    }
    if (added === 0) break;
  }
  return quotas;
}

function classifyNodeStatus(
  label: string,
  filePath: string | null,
  properties: Record<string, unknown>,
  incomingCalls: number,
): 'dead' | 'single' | 'entry' | 'test' | 'exported' | 'normal' | 'structural' {
  const normalizedPath = (filePath ?? '').replace(/\\/g, '/').toLowerCase();
  if (
    /(^|\/)(?:__tests__|tests?|specs?|fixtures)(\/|$)/u.test(normalizedPath)
    || /\.(?:test|spec)\.[^/]+$/u.test(normalizedPath)
  ) return 'test';
  // Test provenance takes precedence over structural shape. A File, Module,
  // or Class inside tests still belongs to the test subgraph and must obey
  // the UI's "Hide tests" filter.
  if (STRUCTURAL_LABELS.has(label)) return 'structural';
  if (
    label === 'Route'
    || properties.is_entry_point === true
    || properties.is_entry_point === 1
    || properties.is_entry_point === 'true'
    || properties.is_entry === true
    || properties.is_entry === 1
    || properties.is_entry === 'true'
  ) {
    return 'entry';
  }
  const exported = properties.is_exported === true
    || properties.is_exported === 1
    || properties.is_exported === 'true'
    || properties.exported === true
    || properties.exported === 1
    || properties.exported === 'true';
  if (exported) return 'exported';
  if (CALLABLE_LABELS.has(label) && incomingCalls === 0) return 'dead';
  if (CALLABLE_LABELS.has(label) && incomingCalls === 1) return 'single';
  return 'normal';
}

function selectBalancedOverviewNodes(
  ctx: RouteContext,
  project: string,
  counts: Record<string, number>,
  maxNodes: number,
) {
  const quotas = allocateBalancedLabelQuotas(counts, maxNodes);
  const buckets = [...quotas.entries()]
    .map(([label, quota]) => ctx.codeReader!.listNodesByLabelRanked(project, label, quota))
    .filter((nodes) => nodes.length > 0);

  // Interleave labels so the deterministic circular seed positions do not
  // create one large monochrome arc per label.
  const nodes = [] as ReturnType<NonNullable<RouteContext['codeReader']>['listNodes']>;
  for (let index = 0; nodes.length < maxNodes; index += 1) {
    let appended = false;
    for (const bucket of buckets) {
      const node = bucket[index];
      if (!node) continue;
      nodes.push(node);
      appended = true;
      if (nodes.length === maxNodes) break;
    }
    if (!appended) break;
  }

  // Degree ranking naturally favors hubs and can otherwise remove every
  // zero-incoming callable from the sample. Reserve a small slice for genuine
  // dead-code candidates so the UI's dead-code view remains functional.
  const deadReserve = Math.min(50, Math.max(1, Math.floor(maxNodes * 0.05)));
  const deadCandidates = ctx.codeReader!
    .listNodesWithoutIncoming(project, [...CALLABLE_LABELS], deadReserve * 4)
    .filter((node) => {
      const props = safeJsonParse(node.properties_json, {} as Record<string, unknown>);
      return classifyNodeStatus(node.label, node.file_path, props, 0) === 'dead';
    })
    .slice(0, deadReserve);
  const selectedIds = new Set(nodes.map((node) => node.id));
  for (const candidate of deadCandidates) {
    if (selectedIds.has(candidate.id)) continue;
    let replacementIndex = -1;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      if (nodes[index].label === candidate.label) {
        replacementIndex = index;
        break;
      }
    }
    if (replacementIndex < 0) continue;
    selectedIds.delete(nodes[replacementIndex].id);
    nodes[replacementIndex] = candidate;
    selectedIds.add(candidate.id);
  }
  return nodes;
}

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
  const availableByLabel = ctx.codeReader.countNodesByLabel(project);
  const nodes = selectBalancedOverviewNodes(ctx, project, availableByLabel, maxNodes);
  const nodeIds = nodes.map((n) => n.id);
  const degreeMap = ctx.codeReader.getBulkNodeDegreesSplit(nodeIds);
  const incomingCalls = ctx.codeReader.getBulkIncomingEdgeCounts(nodeIds, 'CALLS');

  const noteCounts = ctx.humanStore.getBulkNoteCountsByCbmNodeIds(project, nodeIds);
  const layoutNodes = nodes.map((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    const radius = 200 + (n.id % 100);
    const degreeSplit = degreeMap.get(n.id) ?? { in: 0, out: 0 };
    const degree = degreeSplit.in + degreeSplit.out;
    const inCalls = incomingCalls.get(n.id) ?? 0;
    const props = safeJsonParse(n.properties_json, {} as Record<string, unknown>);
    const complexity = Number(props.complexity_avg ?? props.complexity ?? 0);
    const notesCount = noteCounts.get(n.id) ?? 0;
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
      status: classifyNodeStatus(n.label, n.file_path, props, inCalls),
      in_calls: inCalls,
      risk_score: riskScore,
      notes_count: notesCount,
    };
  });

  const edges = ctx.codeReader.getBulkEdges(nodeIds, 20);
  // R50 (#2): countNodes is ~1ms vs getGraphStatus 50-200ms.
  const totalNodes = ctx.codeReader.countNodes(project);
  const returnedByLabel: Record<string, number> = {};
  for (const node of nodes) returnedByLabel[node.label] = (returnedByLabel[node.label] ?? 0) + 1;

  sendJson(res, 200, {
    nodes: layoutNodes,
    edges,
    total_nodes: totalNodes,
    returned_nodes: layoutNodes.length,
    truncated: layoutNodes.length < totalNodes,
    sampling: {
      strategy: 'balanced-degree-v1',
      node_limit: maxNodes,
      available_by_label: availableByLabel,
      returned_by_label: returnedByLabel,
    },
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
  const graphStatus = getGraphStatus(
    project,
    ctx.codeReader,
    ctx.codeReader?.getProjectRoot(project) ?? process.cwd(),
  );
  const freshnessScore = getFreshnessScore(graphStatus);

  const labelCounts = ctx.humanStore.countNodesByLabel(project);
  const activeLabelCounts = ctx.humanStore.countActiveNodesByLabel(project);
  const adrs = labelCounts['ADR'] ?? 0;
  const bugs = labelCounts['BugNote'] ?? 0;
  const activeBugs = activeLabelCounts['BugNote'] ?? 0;
  const refactors = labelCounts['RefactorPlan'] ?? 0;
  const activeRefactors = activeLabelCounts['RefactorPlan'] ?? 0;
  const conventions = labelCounts['Convention'] ?? 0;
  const totalNotes = labelCounts['_total'] ?? 0;

  let criticalTotal = 0;
  let criticalDocumented = 0;
  let scannedModules = 0;
  let moduleScanTruncated = false;
  if (ctx.codeReader) {
    const moduleProbe = ctx.codeReader.listModules(project, MAX_NODES_PER_LABEL + 1);
    moduleScanTruncated = moduleProbe.length > MAX_NODES_PER_LABEL;
    const modules = moduleProbe.slice(0, MAX_NODES_PER_LABEL);
    scannedModules = modules.length;
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
    recommendations.push(`Refresh code graph: ${graphStatus.stale_reason}. Use Control → Index or run "cbm-v2 index --project <name> --root <path>".`);
  }
  if (activeBugs > 0) {
    recommendations.push(`${activeBugs} open bug(s) — review before making changes.`);
  }
  if (activeRefactors > 0) {
    recommendations.push(`${activeRefactors} pending refactor plan(s) — check if your work overlaps.`);
  }
  if (moduleScanTruncated) {
    recommendations.push(`Documentation coverage is partial: only the first ${scannedModules} modules were scanned. Critical-module counts are lower bounds.`);
  }
  if (criticalTotal > 0 && criticalDocumented < criticalTotal) {
    const qualifier = moduleScanTruncated ? 'at least ' : '';
    recommendations.push(`Documentation coverage is ${((criticalDocumented / criticalTotal) * 100).toFixed(0)}% — ${qualifier}${criticalTotal - criticalDocumented} critical module(s) undocumented.`);
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
      active_bugs: activeBugs,
      refactors,
      active_refactors: activeRefactors,
      conventions,
    },
    documentation_coverage: {
      critical_modules_total: criticalTotal,
      critical_modules_documented: criticalDocumented,
      coverage_pct: criticalTotal > 0 ? (criticalDocumented / criticalTotal) * 100 : null,
      scanned_modules: scannedModules,
      module_scan_limit: MAX_NODES_PER_LABEL,
      scan_truncated: moduleScanTruncated,
      critical_counts_are_lower_bounds: moduleScanTruncated,
      coverage_is_partial: moduleScanTruncated,
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
  const status = getGraphStatus(
    project,
    ctx.codeReader,
    ctx.codeReader?.getProjectRoot(project) ?? process.cwd(),
  );
  const score = getFreshnessScore(status);
  sendJson(res, 200, {
    ...status,
    freshness_score: score,
    freshness_label: freshnessLabel(score),
  });
}
