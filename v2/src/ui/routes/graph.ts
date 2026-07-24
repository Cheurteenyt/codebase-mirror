// v2/src/ui/routes/graph.ts
// R63: graph data routes — layout, dashboard, graph-status.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { getGraphStatus, getFreshnessScore, freshnessLabel } from '../../intelligence/graph-status.js';
import { computeRiskScore } from '../../reports/risk.js';
import { safeJsonParse, MAX_NODES_PER_LABEL } from '../../constants.js';
import { sendJson, colorForLabel } from '../helpers.js';
import type { RouteContext } from '../types.js';
import type {
  ArchitectureDomainDependencySummary,
  ArchitectureDomainSummary,
  CodeNode,
  ExactScopeKind,
} from '../../bridge/sqlite-ro.js';
import { architectureDomainKey, graphCommunityKey } from '../../graph-scope.js';
import {
  GOLDEN_ANGLE,
  packGraphCircles,
  roundGraphCoordinate,
  stableGraphHash,
  stableStringCompare,
} from '../../graph-layout-primitives.js';
import {
  positionExactScopeLayoutNode,
  type ExactScopeLayoutPlan,
} from '../../exact-scope-layout.js';

const STRUCTURAL_LABELS = new Set([
  'File', 'Module', 'Package', 'Namespace', 'Class', 'Interface', 'Trait', 'Enum',
]);
const CALLABLE_LABELS = new Set(['Function', 'Method', 'Constructor']);
const CLUSTER_NODE_SPACING = 16;
const CLUSTER_PADDING = 28;
const CLUSTER_GAP = 36;
const PATH_DEFAULT_MAX_HOPS = 6;
const PATH_MAX_HOPS = 8;
const PATH_MAX_VISITED_NODES = 5_000;
const PATH_MAX_VISITED_EDGES = 20_000;
const CLUSTER_SPIRAL_STEP = 48;
const DOMAIN_PADDING = 58;
const DOMAIN_GAP = 92;
const DOMAIN_SPIRAL_STEP = 80;
const DEPENDENCY_ATLAS_MAX_DOMAINS = 12;
const DEPENDENCY_ATLAS_MIN_RADIUS = 72;
const DEPENDENCY_ATLAS_RADIUS_RANGE = 150;
const DEPENDENCY_ATLAS_GAP = 92;

interface ClusterableNode {
  id: number;
  label: string;
  file_path: string | null;
}

interface LayoutCluster {
  id: number;
  domain_id: number;
  key: string;
  x: number;
  y: number;
  radius: number;
  node_count: number;
}

interface LayoutDomain {
  id: number;
  key: string;
  x: number;
  y: number;
  radius: number;
  node_count: number;
  cluster_count: number;
}

interface StructuredPosition {
  x: number;
  y: number;
  clusterId: number;
}

interface PackedLayoutCluster {
  id: number;
  domainId: number;
  domainKey: string;
  key: string;
  nodes: ClusterableNode[];
  radius: number;
  x: number;
  y: number;
}

interface PackedLayoutDomain {
  id: number;
  key: string;
  clusters: PackedLayoutCluster[];
  radius: number;
  x: number;
  y: number;
  nodeCount: number;
}

interface PackedDependencyAtlasDomain {
  id: number;
  key: string;
  node_count: number;
  file_count: number;
  representative_node_id: number;
  radius: number;
  x: number;
  y: number;
  incoming_edges: number;
  outgoing_edges: number;
  internal_edges: number;
}

function computeTopologyRevision(
  nodes: ReadonlyArray<{
    id: number;
    x: number;
    y: number;
    size: number;
    cluster_id: number;
  }>,
  edges: ReadonlyArray<{ source: number; target: number; type: string }>,
): string {
  const hash = createHash('sha256');
  for (const node of nodes) {
    hash.update(`n:${node.id}:${node.x}:${node.y}:${node.size}:${node.cluster_id};`);
  }
  for (const edge of edges) hash.update(`e:${edge.source}:${edge.target}:${edge.type};`);
  return `architecture-domain-v1:${hash.digest('base64url').slice(0, 22)}`;
}

export function ensureArchitectureDomainCoverage<T extends ClusterableNode>(
  selectedNodes: readonly T[],
  coverageCandidates: readonly T[],
  maxNodes: number,
): T[] {
  const nodes = [...selectedNodes];
  if (nodes.length === 0 || coverageCandidates.length === 0 || maxNodes <= 0) return nodes;

  const domainFor = (node: T) => architectureDomainKey(graphCommunityKey(node.file_path, node.label));
  const domainCounts = new Map<string, number>();
  const labelCounts = new Map<string, number>();
  const selectedIds = new Set<number>();
  for (const node of nodes) {
    const domain = domainFor(node);
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    labelCounts.set(node.label, (labelCounts.get(node.label) ?? 0) + 1);
    selectedIds.add(node.id);
  }

  const representativeByDomain = new Map<string, T>();
  for (const candidate of coverageCandidates) {
    const domain = domainFor(candidate);
    const existing = representativeByDomain.get(domain);
    if (!existing || candidate.id < existing.id) representativeByDomain.set(domain, candidate);
  }

  for (const [domain, candidate] of [...representativeByDomain.entries()]
    .sort(([left], [right]) => stableStringCompare(left, right))) {
    if ((domainCounts.get(domain) ?? 0) > 0 || selectedIds.has(candidate.id)) continue;
    if (nodes.length < maxNodes) {
      nodes.push(candidate);
      selectedIds.add(candidate.id);
      domainCounts.set(domain, 1);
      labelCounts.set(candidate.label, (labelCounts.get(candidate.label) ?? 0) + 1);
      continue;
    }

    let replacementIndex = -1;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const current = nodes[index];
      if (current.label === candidate.label && (domainCounts.get(domainFor(current)) ?? 0) > 1) {
        replacementIndex = index;
        break;
      }
    }
    if (replacementIndex < 0) {
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const current = nodes[index];
        if (
          (domainCounts.get(domainFor(current)) ?? 0) > 1
          && (labelCounts.get(current.label) ?? 0) > 1
        ) {
          replacementIndex = index;
          break;
        }
      }
    }
    if (replacementIndex < 0) continue;

    const replaced = nodes[replacementIndex];
    const replacedDomain = domainFor(replaced);
    selectedIds.delete(replaced.id);
    domainCounts.set(replacedDomain, (domainCounts.get(replacedDomain) ?? 1) - 1);
    labelCounts.set(replaced.label, (labelCounts.get(replaced.label) ?? 1) - 1);
    nodes[replacementIndex] = candidate;
    selectedIds.add(candidate.id);
    domainCounts.set(domain, 1);
    labelCounts.set(candidate.label, (labelCounts.get(candidate.label) ?? 0) + 1);
  }
  return nodes;
}

/**
 * Seed a deterministic 2D technical map before d3 performs its gentle local
 * refinement. V1's strongest visual property was its directory clustering;
 * this keeps that structure while using collision-aware 2D packing instead of
 * a 3D globe and a global force hairball.
 */
export function buildStructuredOverview(
  nodes: readonly ClusterableNode[],
  degreeMap: Map<number, { in: number; out: number }>,
): {
  positions: Map<number, StructuredPosition>;
  clusters: LayoutCluster[];
  domains: LayoutDomain[];
} {
  const grouped = new Map<string, ClusterableNode[]>();
  for (const node of nodes) {
    const key = graphCommunityKey(node.file_path, node.label);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(node);
    else grouped.set(key, [node]);
  }

  const alphabetical: PackedLayoutCluster[] = [...grouped.entries()]
    .sort(([keyA], [keyB]) => stableStringCompare(keyA, keyB))
    .map(([key, clusterNodes], id) => {
      const furthestNode = clusterNodes.length <= 1
        ? 0
        : 14 + Math.sqrt(clusterNodes.length - 1) * CLUSTER_NODE_SPACING;
      return {
        id,
        domainId: 0,
        domainKey: architectureDomainKey(key),
        key,
        nodes: clusterNodes,
        radius: Math.max(52, Math.ceil(furthestNode + CLUSTER_PADDING)),
        x: 0,
        y: 0,
      };
    });

  const clustersByDomain = new Map<string, PackedLayoutCluster[]>();
  for (const cluster of alphabetical) {
    const bucket = clustersByDomain.get(cluster.domainKey);
    if (bucket) bucket.push(cluster);
    else clustersByDomain.set(cluster.domainKey, [cluster]);
  }
  const domains: PackedLayoutDomain[] = [...clustersByDomain.entries()]
    .sort(([keyA], [keyB]) => stableStringCompare(keyA, keyB))
    .map(([key, clusters], id) => {
      for (const cluster of clusters) cluster.domainId = id;
      packGraphCircles(clusters, CLUSTER_GAP, CLUSTER_SPIRAL_STEP);

      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const cluster of clusters) {
        minX = Math.min(minX, cluster.x - cluster.radius);
        minY = Math.min(minY, cluster.y - cluster.radius);
        maxX = Math.max(maxX, cluster.x + cluster.radius);
        maxY = Math.max(maxY, cluster.y + cluster.radius);
      }
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      for (const cluster of clusters) {
        cluster.x -= centerX;
        cluster.y -= centerY;
      }
      const radius = Math.max(
        ...clusters.map((cluster) => Math.hypot(cluster.x, cluster.y) + cluster.radius),
      ) + DOMAIN_PADDING;
      return {
        id,
        key,
        clusters,
        radius: Math.ceil(radius),
        x: 0,
        y: 0,
        nodeCount: clusters.reduce((sum, cluster) => sum + cluster.nodes.length, 0),
      };
    });

  // Keep top-level architecture domains visually distinct. Communities are
  // packed inside their domain first, then domains are packed as larger
  // collision-aware circles. This prevents unrelated roots from intermixing.
  packGraphCircles(domains, DOMAIN_GAP, DOMAIN_SPIRAL_STEP);
  for (const domain of domains) {
    for (const cluster of domain.clusters) {
      cluster.x += domain.x;
      cluster.y += domain.y;
    }
  }

  const positions = new Map<number, StructuredPosition>();
  for (const cluster of alphabetical) {
    const phase = (stableGraphHash(cluster.key) / 0xffffffff) * Math.PI * 2;
    const rankedNodes = [...cluster.nodes].sort((nodeA, nodeB) => {
      const structuralA = STRUCTURAL_LABELS.has(nodeA.label) ? 0 : 1;
      const structuralB = STRUCTURAL_LABELS.has(nodeB.label) ? 0 : 1;
      if (structuralA !== structuralB) return structuralA - structuralB;
      const degreeA = degreeMap.get(nodeA.id) ?? { in: 0, out: 0 };
      const degreeB = degreeMap.get(nodeB.id) ?? { in: 0, out: 0 };
      const totalA = degreeA.in + degreeA.out;
      const totalB = degreeB.in + degreeB.out;
      return totalB - totalA || nodeA.id - nodeB.id;
    });

    rankedNodes.forEach((node, index) => {
      const radius = index === 0 ? 0 : 14 + Math.sqrt(index) * CLUSTER_NODE_SPACING;
      const angle = phase + index * GOLDEN_ANGLE;
      positions.set(node.id, {
        x: roundGraphCoordinate(cluster.x + Math.cos(angle) * radius),
        y: roundGraphCoordinate(cluster.y + Math.sin(angle) * radius),
        clusterId: cluster.id,
      });
    });
  }

  return {
    positions,
    clusters: alphabetical.map((cluster) => ({
      id: cluster.id,
      domain_id: cluster.domainId,
      key: cluster.key,
      x: roundGraphCoordinate(cluster.x),
      y: roundGraphCoordinate(cluster.y),
      radius: cluster.radius,
      node_count: cluster.nodes.length,
    })),
    domains: domains.map((domain) => ({
      id: domain.id,
      key: domain.key,
      x: roundGraphCoordinate(domain.x),
      y: roundGraphCoordinate(domain.y),
      radius: domain.radius,
      node_count: domain.nodeCount,
      cluster_count: domain.clusters.length,
    })),
  };
}

/**
 * Build one exact, bounded project-level dependency atlas. Circle area uses a
 * bounded square-root scale, while labels retain the exact counts. Relations
 * to omitted domains remain in per-domain traffic totals but are not rendered
 * as a misleading synthetic node.
 */
function selectDependencyAtlasDomains(
  domains: readonly ArchitectureDomainSummary[],
): ArchitectureDomainSummary[] {
  return [...domains]
    .sort((left, right) => (
      right.node_count - left.node_count
      || right.file_count - left.file_count
      || stableStringCompare(left.key, right.key)
    ))
    .slice(0, DEPENDENCY_ATLAS_MAX_DOMAINS);
}

export function buildDependencyAtlas(
  domains: readonly ArchitectureDomainSummary[],
  dependencies: readonly ArchitectureDomainDependencySummary[],
) {
  const rankedDomains = selectDependencyAtlasDomains(domains);
  const maximumNodeCount = Math.max(1, ...rankedDomains.map((domain) => domain.node_count));
  const atlasDomains: PackedDependencyAtlasDomain[] = rankedDomains.map((domain, id) => ({
    id,
    key: domain.key,
    node_count: domain.node_count,
    file_count: domain.file_count,
    representative_node_id: domain.representative.id,
    radius: Math.round(
      DEPENDENCY_ATLAS_MIN_RADIUS
      + DEPENDENCY_ATLAS_RADIUS_RANGE * Math.sqrt(domain.node_count / maximumNodeCount),
    ),
    x: 0,
    y: 0,
    incoming_edges: 0,
    outgoing_edges: 0,
    internal_edges: 0,
  }));
  packGraphCircles(atlasDomains, DEPENDENCY_ATLAS_GAP, DOMAIN_SPIRAL_STEP);

  const selectedDomains = new Map(atlasDomains.map((domain) => [domain.key, domain]));
  const relations: Array<{
    source_key: string;
    target_key: string;
    type: string;
    count: number;
  }> = [];
  for (const dependency of dependencies) {
    const source = dependency.source_key == null
      ? undefined
      : selectedDomains.get(dependency.source_key);
    const target = dependency.target_key == null
      ? undefined
      : selectedDomains.get(dependency.target_key);
    if (source && target && source.id === target.id) {
      source.internal_edges += dependency.count;
      continue;
    }
    // In/out are boundary traffic. Keeping internal edges separate prevents a
    // large cohesive domain from looking externally coupled merely because it
    // contains many local relationships.
    if (source) source.outgoing_edges += dependency.count;
    if (target) target.incoming_edges += dependency.count;
    if (source && target) relations.push({
      source_key: source.key,
      target_key: target.key,
      type: dependency.type,
      count: dependency.count,
    });
  }

  const totalNodes = domains.reduce((sum, domain) => sum + domain.node_count, 0);
  const returnedNodes = atlasDomains.reduce((sum, domain) => sum + domain.node_count, 0);
  return {
    strategy: 'exact-domain-dependencies-v1' as const,
    exact: true as const,
    coverage: {
      complete: atlasDomains.length === domains.length,
      total_domains: domains.length,
      returned_domains: atlasDomains.length,
      total_nodes: totalNodes,
      returned_nodes: returnedNodes,
    },
    domains: atlasDomains.map((domain) => ({
      ...domain,
      x: roundGraphCoordinate(domain.x),
      y: roundGraphCoordinate(domain.y),
    })),
    relation_count: relations.reduce((sum, relation) => sum + relation.count, 0),
    relations,
  };
}

function allocateBalancedLabelQuotas(
  counts: Record<string, number>,
  maxNodes: number,
): Map<string, number> {
  const labels = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([labelA, countA], [labelB, countB]) => (
      countB - countA || stableStringCompare(labelA, labelB)
    ));
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

function serializeUnpositionedGraphNodes(
  ctx: RouteContext,
  project: string,
  nodes: readonly CodeNode[],
) {
  const nodeIds = nodes.map((node) => node.id);
  const degreeMap = ctx.codeReader!.getBulkNodeDegreesSplit(nodeIds);
  const incomingCalls = ctx.codeReader!.getBulkIncomingEdgeCounts(nodeIds, 'CALLS');
  const noteCounts = ctx.humanStore.getBulkNoteCountsByCbmNodeIds(project, nodeIds);
  return nodes.map((node) => {
    const degreeSplit = degreeMap.get(node.id) ?? { in: 0, out: 0 };
    const degree = degreeSplit.in + degreeSplit.out;
    const inCalls = incomingCalls.get(node.id) ?? 0;
    const props = safeJsonParse(node.properties_json, {} as Record<string, unknown>);
    const complexity = Number(props.complexity_avg ?? props.complexity ?? 0);
    const notesCount = noteCounts.get(node.id) ?? 0;
    return {
      id: node.id,
      x: 0,
      y: 0,
      label: node.label,
      name: node.name,
      file_path: node.file_path,
      qualified_name: node.qualified_name,
      start_line: node.start_line,
      end_line: node.end_line,
      size: Math.max(3, Math.min(12, Math.sqrt(degree) + 3)),
      color: colorForLabel(node.label),
      status: classifyNodeStatus(node.label, node.file_path, props, inCalls),
      in_degree: degreeSplit.in,
      out_degree: degreeSplit.out,
      in_calls: inCalls,
      risk_score: computeRiskScore(degree, complexity, notesCount),
      notes_count: notesCount,
    };
  });
}

function selectBalancedOverviewNodes(
  ctx: RouteContext,
  project: string,
  counts: Record<string, number>,
  maxNodes: number,
  coverageCandidates: readonly CodeNode[],
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
  const totalAvailable = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (totalAvailable <= maxNodes || coverageCandidates.length === 0) return nodes;
  return ensureArchitectureDomainCoverage(nodes, coverageCandidates, maxNodes);
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
  const snapshot = ctx.codeReader!.withGraphSnapshot(null, () => {
    const availableByLabel = ctx.codeReader!.countNodesByLabel(project);
    const architectureDomains = ctx.codeReader!.listArchitectureDomains(project);
    const dependencyAtlasDomains = selectDependencyAtlasDomains(architectureDomains);
    const dependencyAtlas = buildDependencyAtlas(
      architectureDomains,
      ctx.codeReader!.listArchitectureDomainDependencies(
        project,
        dependencyAtlasDomains.map((domain) => domain.key),
      ),
    );
    const nodes = selectBalancedOverviewNodes(
      ctx,
      project,
      availableByLabel,
      maxNodes,
      architectureDomains.map((domain) => domain.representative),
    );
    const nodeIds = nodes.map((n) => n.id);
    const degreeMap = ctx.codeReader!.getBulkNodeDegreesSplit(nodeIds);
    const incomingCalls = ctx.codeReader!.getBulkIncomingEdgeCounts(nodeIds, 'CALLS');
    const structuredOverview = buildStructuredOverview(nodes, degreeMap);

    const noteCounts = ctx.humanStore.getBulkNoteCountsByCbmNodeIds(project, nodeIds);
    const layoutNodes = nodes.map((n) => {
      const position = structuredOverview.positions.get(n.id) ?? { x: 0, y: 0, clusterId: 0 };
      const degreeSplit = degreeMap.get(n.id) ?? { in: 0, out: 0 };
      const degree = degreeSplit.in + degreeSplit.out;
      const inCalls = incomingCalls.get(n.id) ?? 0;
      const props = safeJsonParse(n.properties_json, {} as Record<string, unknown>);
      const complexity = Number(props.complexity_avg ?? props.complexity ?? 0);
      const notesCount = noteCounts.get(n.id) ?? 0;
      const riskScore = computeRiskScore(degree, complexity, notesCount);

      return {
        id: n.id,
        x: position.x,
        y: position.y,
        cluster_id: position.clusterId,
        label: n.label,
        name: n.name,
        file_path: n.file_path,
        qualified_name: n.qualified_name,
        start_line: n.start_line,
        end_line: n.end_line,
        size: Math.max(3, Math.min(12, Math.sqrt(degree) + 3)),
        color: colorForLabel(n.label),
        status: classifyNodeStatus(n.label, n.file_path, props, inCalls),
        in_degree: degreeSplit.in,
        out_degree: degreeSplit.out,
        in_calls: inCalls,
        risk_score: riskScore,
        notes_count: notesCount,
      };
    });

    const edgeSampling = ctx.codeReader!.getBulkEdgesWithStats(nodeIds, 20);
    const topologyRevision = computeTopologyRevision(layoutNodes, edgeSampling.edges);
    // R50 (#2): countNodes is ~1ms vs getGraphStatus 50-200ms.
    const totalNodes = ctx.codeReader!.countNodes(project);
    const returnedByLabel: Record<string, number> = {};
    for (const node of nodes) {
      returnedByLabel[node.label] = (returnedByLabel[node.label] ?? 0) + 1;
    }

    return {
      contract_version: 1,
      nodes: layoutNodes,
      edges: edgeSampling.edges,
      total_nodes: totalNodes,
      returned_nodes: layoutNodes.length,
      topology_revision: topologyRevision,
      truncated: layoutNodes.length < totalNodes,
      sampling: {
        strategy: 'architecture-coverage-v1',
        node_limit: maxNodes,
        available_by_label: availableByLabel,
        returned_by_label: returnedByLabel,
      },
      edge_sampling: {
        strategy: edgeSampling.strategy,
        total_induced_edges: edgeSampling.total_induced_edges,
        returned_edges: edgeSampling.returned_edges,
        edges_truncated: edgeSampling.edges_truncated,
        limit_per_direction: edgeSampling.limit_per_direction,
        available_by_type: edgeSampling.available_by_type,
        returned_by_type: edgeSampling.returned_by_type,
      },
      layout: {
        strategy: 'architecture-domain-v1',
        node_spacing: CLUSTER_NODE_SPACING,
        counts_scope: 'returned_nodes',
        clusters: structuredOverview.clusters,
        domains: structuredOverview.domains,
        domain_catalog: {
          exact: true,
          counts_scope: 'all_nodes',
          total_domains: architectureDomains.length,
          domains: architectureDomains.map((domain) => ({
            key: domain.key,
            node_count: domain.node_count,
            file_count: domain.file_count,
            representative_node_id: domain.representative.id,
          })),
        },
        dependency_atlas: dependencyAtlas,
      },
    };
  });
  // A null expected revision cannot produce a mismatch. Keep the guard so a
  // future GraphSnapshotResult variant cannot accidentally serve partial data.
  if (!snapshot.ok) {
    throw new Error('Unexpected graph revision mismatch while building the layout');
  }
  sendJson(res, 200, {
    ...snapshot.value,
    graph_revision: snapshot.graph_revision,
  });
}

interface NeighborhoodCursor {
  v: 1;
  project: string;
  node_id: number;
  after_edge_id: number;
  graph_revision: string;
}

interface SearchCursor {
  v: 1;
  project: string;
  query: string;
  match_version: 'literal-relevance-v1';
  after_rank: number;
  after_node_id: number;
  graph_revision: string;
}

interface ScopeCursor {
  v: 1;
  project: string;
  kind: ExactScopeKind;
  key: string;
  after_node_id: number;
  batch_end_node_id: number;
  after_edge_id: number;
  graph_revision: string;
}

function isGraphRevision(value: unknown): value is string {
  return typeof value === 'string' && /^graph-reader-v1:[A-Za-z0-9_-]{22}$/u.test(value);
}

function sendGraphRevisionMismatch(
  res: ServerResponse,
  expectedGraphRevision: string,
  graphRevision: string,
): void {
  sendJson(res, 409, {
    contract_version: 1,
    error: 'graph_revision_mismatch',
    code: 'GRAPH_REVISION_MISMATCH',
    message: 'The graph changed while this result was being paginated. Restart from the first page.',
    expected_graph_revision: expectedGraphRevision,
    graph_revision: graphRevision,
    restart_from_first_page: true,
  });
}

function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function encodeScopeCursor(cursor: ScopeCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeScopeCursor(
  encoded: string,
  project: string,
  kind: ExactScopeKind,
  key: string,
): {
  afterNodeId: number;
  batchEndNodeId: number;
  afterEdgeId: number;
  graphRevision: string;
} | null {
  if (encoded.length === 0 || encoded.length > 1536) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<ScopeCursor>;
    const afterNodeId = parsed.after_node_id ?? -1;
    const batchEndNodeId = parsed.batch_end_node_id ?? -1;
    const afterEdgeId = parsed.after_edge_id ?? -1;
    const isNodeContinuation = batchEndNodeId === 0 && afterEdgeId === 0 && afterNodeId > 0;
    const isEdgeContinuation = batchEndNodeId > afterNodeId && afterEdgeId > 0;
    if (
      parsed.v !== 1
      || parsed.project !== project
      || parsed.kind !== kind
      || parsed.key !== key
      || !Number.isSafeInteger(afterNodeId)
      || !Number.isSafeInteger(batchEndNodeId)
      || !Number.isSafeInteger(afterEdgeId)
      || !(isNodeContinuation || isEdgeContinuation)
      || !isGraphRevision(parsed.graph_revision)
    ) return null;
    return { afterNodeId, batchEndNodeId, afterEdgeId, graphRevision: parsed.graph_revision! };
  } catch {
    return null;
  }
}

function positionExactScopeNodes(
  nodes: ReturnType<typeof serializeUnpositionedGraphNodes>,
  layout: ExactScopeLayoutPlan,
) {
  return nodes.map((node) => positionExactScopeLayoutNode(layout, node));
}

function decodeSearchCursor(
  encoded: string,
  project: string,
  query: string,
): { afterRank: number; afterNodeId: number; graphRevision: string } | null {
  if (encoded.length === 0 || encoded.length > 1024) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SearchCursor>;
    if (
      parsed.v !== 1
      || parsed.project !== project
      || parsed.query !== query
      || parsed.match_version !== 'literal-relevance-v1'
      || !Number.isSafeInteger(parsed.after_rank)
      || (parsed.after_rank ?? -1) < 0
      || (parsed.after_rank ?? 6) > 5
      || !Number.isSafeInteger(parsed.after_node_id)
      || (parsed.after_node_id ?? 0) <= 0
      || !isGraphRevision(parsed.graph_revision)
    ) return null;
    return {
      afterRank: parsed.after_rank!,
      afterNodeId: parsed.after_node_id!,
      graphRevision: parsed.graph_revision,
    };
  } catch {
    return null;
  }
}

/** Exact project-wide literal search, ranked and keyset-paginated. */
export async function routeNodeSearch(
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
  const rawQuery = url.searchParams.get('q');
  const query = rawQuery?.trim() ?? '';
  const containsControlCharacters = rawQuery != null && /[\u0000-\u001f\u007f]/u.test(rawQuery);
  if (
    rawQuery == null
    || query.length === 0
    || query.length > 256
    || containsControlCharacters
  ) {
    sendJson(res, 400, { error: 'q must contain 1 to 256 printable characters' });
    return;
  }
  const rawLimit = url.searchParams.get('limit') ?? '50';
  if (!/^[1-9][0-9]*$/u.test(rawLimit)) {
    sendJson(res, 400, { error: 'limit must be an integer between 1 and 250' });
    return;
  }
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
    sendJson(res, 400, { error: 'limit must be an integer between 1 and 250' });
    return;
  }
  const encodedCursor = url.searchParams.get('cursor');
  const cursor = encodedCursor == null
    ? { afterRank: -1, afterNodeId: 0, graphRevision: null }
    : decodeSearchCursor(encodedCursor, project, query);
  if (!cursor) {
    sendJson(res, 400, { error: 'cursor is invalid for this query or project' });
    return;
  }

  const snapshot = ctx.codeReader.withGraphSnapshot(cursor.graphRevision, (graphRevision) => {
    const page = ctx.codeReader!.searchNodesExactPage(
      project,
      query,
      cursor.afterRank,
      cursor.afterNodeId,
      limit,
    );
    const nextCursor = page.next_after_rank == null || page.next_after_node_id == null
      ? null
      : encodeSearchCursor({
        v: 1,
        project,
        query,
        match_version: 'literal-relevance-v1',
        after_rank: page.next_after_rank,
        after_node_id: page.next_after_node_id,
        graph_revision: graphRevision,
      });
    return {
      page,
      nextCursor,
      nodes: serializeUnpositionedGraphNodes(ctx, project, page.nodes),
    };
  });
  if (!snapshot.ok) {
    sendGraphRevisionMismatch(
      res,
      snapshot.expected_graph_revision,
      snapshot.graph_revision,
    );
    return;
  }
  const { page, nextCursor, nodes } = snapshot.value;

  sendJson(res, 200, {
    contract_version: 1,
    exact: true,
    graph_revision: snapshot.graph_revision,
    scope: 'complete_project',
    query,
    match_strategy: 'literal-relevance-v1',
    total_matches: page.total_matches,
    returned_nodes: page.nodes.length,
    truncated: nextCursor !== null,
    nodes,
    page: {
      limit,
      returned: page.nodes.length,
      next_cursor: nextCursor,
    },
  });
}

/** Exact, revision-bound architecture scope with bounded node/edge pages. */
export async function routeScope(
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
  const rawKind = url.searchParams.get('kind');
  if (rawKind !== 'domain' && rawKind !== 'community' && rawKind !== 'directory') {
    sendJson(res, 400, { error: 'kind must be domain, community, or directory' });
    return;
  }
  const kind: ExactScopeKind = rawKind;
  const key = url.searchParams.get('key');
  if (
    key == null
    || key.trim().length === 0
    || key.length > 512
    || /[\u0000-\u001f\u007f]/u.test(key)
  ) {
    sendJson(res, 400, { error: 'key must contain 1 to 512 printable characters' });
    return;
  }
  const rawLimit = url.searchParams.get('limit') ?? '100';
  if (!/^[1-9][0-9]*$/u.test(rawLimit)) {
    sendJson(res, 400, { error: 'limit must be an integer between 1 and 250' });
    return;
  }
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
    sendJson(res, 400, { error: 'limit must be an integer between 1 and 250' });
    return;
  }
  const encodedCursor = url.searchParams.get('cursor');
  const cursor = encodedCursor == null
    ? { afterNodeId: 0, batchEndNodeId: 0, afterEdgeId: 0, graphRevision: null }
    : decodeScopeCursor(encodedCursor, project, kind, key);
  if (!cursor) {
    sendJson(res, 400, { error: 'cursor is invalid for this scope or project' });
    return;
  }

  const snapshot = ctx.codeReader.withGraphSnapshot(cursor.graphRevision, (graphRevision) => {
    const page = ctx.codeReader!.getExactScopePage(
      project,
      kind,
      key,
      {
        after_node_id: cursor.afterNodeId,
        batch_end_node_id: cursor.batchEndNodeId,
        after_edge_id: cursor.afterEdgeId,
      },
      limit,
      limit,
    );
    const nextCursor = page.next_cursor == null
      ? null
      : encodeScopeCursor({
          v: 1,
          project,
          kind,
          key,
          ...page.next_cursor,
          graph_revision: graphRevision,
        });
    const serializedNodes = serializeUnpositionedGraphNodes(ctx, project, page.nodes);
    return {
      page,
      nextCursor,
      nodes: positionExactScopeNodes(serializedNodes, page.structure_layout),
      layout: page.structure_layout.layout,
    };
  });
  if (!snapshot.ok) {
    sendGraphRevisionMismatch(res, snapshot.expected_graph_revision, snapshot.graph_revision);
    return;
  }
  const { page, nextCursor, nodes, layout } = snapshot.value;

  sendJson(res, 200, {
    contract_version: 1,
    exact: true,
    graph_revision: snapshot.graph_revision,
    scope: {
      kind,
      key,
      total_nodes: page.total_nodes,
      total_internal_edges: page.total_internal_edges,
    },
    boundary: page.boundary,
    nodes,
    layout: encodedCursor == null ? layout : undefined,
    edges: page.edges.map((edge) => ({
      id: edge.id,
      source: edge.source_id,
      target: edge.target_id,
      type: edge.type,
    })),
    complete: nextCursor === null,
    page: {
      node_limit: limit,
      edge_limit: limit,
      returned_nodes: page.nodes.length,
      returned_edges: page.edges.length,
      next_cursor: nextCursor,
    },
  });
}

function encodeNeighborhoodCursor(cursor: NeighborhoodCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeNeighborhoodCursor(
  encoded: string,
  project: string,
  nodeId: number,
): { afterEdgeId: number; graphRevision: string } | null {
  if (encoded.length === 0 || encoded.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<NeighborhoodCursor>;
    if (
      parsed.v !== 1
      || parsed.project !== project
      || parsed.node_id !== nodeId
      || !Number.isSafeInteger(parsed.after_edge_id)
      || (parsed.after_edge_id ?? -1) < 0
      || !isGraphRevision(parsed.graph_revision)
    ) return null;
    return {
      afterEdgeId: parsed.after_edge_id!,
      graphRevision: parsed.graph_revision,
    };
  } catch {
    return null;
  }
}

/** Exact, bounded drill-down for one node; /api/layout remains an overview. */
export async function routeNeighborhood(
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
  const rawNodeId = url.searchParams.get('node_id');
  if (!rawNodeId || !/^[1-9][0-9]*$/u.test(rawNodeId)) {
    sendJson(res, 400, { error: 'node_id must be a positive integer' });
    return;
  }
  const nodeId = Number(rawNodeId);
  if (!Number.isSafeInteger(nodeId)) {
    sendJson(res, 400, { error: 'node_id is outside the safe integer range' });
    return;
  }
  const rawLimit = url.searchParams.get('limit') ?? '100';
  if (!/^[1-9][0-9]*$/u.test(rawLimit)) {
    sendJson(res, 400, { error: 'limit must be an integer between 1 and 250' });
    return;
  }
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
    sendJson(res, 400, { error: 'limit must be an integer between 1 and 250' });
    return;
  }
  const encodedCursor = url.searchParams.get('cursor');
  const cursor = encodedCursor == null
    ? { afterEdgeId: 0, graphRevision: null }
    : decodeNeighborhoodCursor(encodedCursor, project, nodeId);
  if (cursor == null) {
    sendJson(res, 400, { error: 'cursor is invalid for this node or project' });
    return;
  }

  const snapshot = ctx.codeReader.withGraphSnapshot(cursor.graphRevision, (graphRevision) => {
    const page = ctx.codeReader!.getExactNeighborhoodPage(
      project,
      nodeId,
      cursor.afterEdgeId,
      limit,
    );
    if (!page) return null;
    const uniqueNodes = new Map(page.neighbors.map(({ node }) => [node.id, node]));
    const nodes = serializeUnpositionedGraphNodes(ctx, project, [...uniqueNodes.values()]);
    const nextCursor = page.next_after_edge_id == null
      ? null
      : encodeNeighborhoodCursor({
          v: 1,
          project,
          node_id: nodeId,
          after_edge_id: page.next_after_edge_id,
          graph_revision: graphRevision,
        });
    return { page, nodes, nextCursor };
  });
  if (!snapshot.ok) {
    sendGraphRevisionMismatch(
      res,
      snapshot.expected_graph_revision,
      snapshot.graph_revision,
    );
    return;
  }
  if (!snapshot.value) {
    sendJson(res, 404, { error: 'Node not found in this project' });
    return;
  }
  const { page, nodes, nextCursor } = snapshot.value;

  sendJson(res, 200, {
    contract_version: 1,
    exact: true,
    graph_revision: snapshot.graph_revision,
    anchor: {
      kind: 'node',
      id: page.anchor.id,
      total_inbound: page.total_inbound,
      total_outbound: page.total_outbound,
      total_unique_edges: page.total_unique_edges,
    },
    nodes,
    edges: page.neighbors.map(({ edge }) => ({
      id: edge.id,
      source: edge.source_id,
      target: edge.target_id,
      type: edge.type,
    })),
    page: {
      limit,
      returned: page.neighbors.length,
      next_cursor: nextCursor,
    },
  });
}

/** Exact, bounded shortest coupling path between two project symbols. */
export async function routePath(
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
  const parseNodeId = (name: 'source_id' | 'target_id'): number | null => {
    const raw = url.searchParams.get(name);
    if (!raw || !/^[1-9][0-9]*$/u.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  };
  const sourceId = parseNodeId('source_id');
  const targetId = parseNodeId('target_id');
  if (sourceId == null || targetId == null) {
    sendJson(res, 400, { error: 'source_id and target_id must be positive safe integers' });
    return;
  }
  const rawMaxHops = url.searchParams.get('max_hops') ?? String(PATH_DEFAULT_MAX_HOPS);
  if (!/^[1-9][0-9]*$/u.test(rawMaxHops)) {
    sendJson(res, 400, { error: `max_hops must be an integer between 1 and ${PATH_MAX_HOPS}` });
    return;
  }
  const maxHops = Number(rawMaxHops);
  if (!Number.isSafeInteger(maxHops) || maxHops < 1 || maxHops > PATH_MAX_HOPS) {
    sendJson(res, 400, { error: `max_hops must be an integer between 1 and ${PATH_MAX_HOPS}` });
    return;
  }

  const snapshot = ctx.codeReader.withGraphSnapshot(null, () => ctx.codeReader!.findExactPath(
    project,
    sourceId,
    targetId,
    {
      maxHops,
      maxVisitedNodes: PATH_MAX_VISITED_NODES,
      maxVisitedEdges: PATH_MAX_VISITED_EDGES,
    },
  ));
  if (!snapshot.ok) throw new Error('A path read without an expected revision cannot mismatch');
  if (!snapshot.value) {
    sendJson(res, 404, { error: 'Source or target node not found in this project' });
    return;
  }
  const result = snapshot.value;
  const searchComplete = result.status === 'found' || result.status === 'not_found';
  sendJson(res, 200, {
    contract_version: 1,
    exact: searchComplete,
    graph_revision: snapshot.graph_revision,
    strategy: 'bounded-undirected-bfs-v1',
    status: result.status,
    source_id: sourceId,
    target_id: targetId,
    hops: result.hops,
    nodes: serializeUnpositionedGraphNodes(ctx, project, result.nodes),
    edges: result.edges.map((edge) => ({
      id: edge.id,
      source: edge.source_id,
      target: edge.target_id,
      type: edge.type,
    })),
    search: {
      complete: searchComplete,
      visited_nodes: result.visited_nodes,
      visited_edges: result.visited_edges,
    },
    limits: {
      max_hops: maxHops,
      max_visited_nodes: PATH_MAX_VISITED_NODES,
      max_visited_edges: PATH_MAX_VISITED_EDGES,
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
