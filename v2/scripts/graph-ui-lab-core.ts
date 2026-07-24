import { createHash } from 'node:crypto';

export const GRAPH_UI_LAB_VERSION = 2 as const;

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

export interface LayoutNodeLike {
  id: number;
}

export interface LayoutEdgeLike {
  source: number;
  target: number;
  type: string;
}

export interface LayoutLike {
  nodes: LayoutNodeLike[];
  edges: LayoutEdgeLike[];
  total_nodes: number;
  returned_nodes?: number;
}

export interface TopologyFingerprint {
  totalNodes: number;
  returnedNodes: number;
  returnedEdges: number;
  complete: boolean;
  nodeDigest: string;
  edgeDigest: string;
  topologyDigest: string;
}

export interface RenderedGraphObservation {
  url: string;
  layout: LayoutLike;
}

export interface RenderedGraphIdentity {
  url: string;
  topology: TopologyFingerprint;
}

export interface TimingSummary {
  runs: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
  coefficientOfVariationPct: number;
}

export interface FrameSummary {
  frameCount: number;
  durationMs: number;
  fps: number;
  p50FrameMs: number;
  p95FrameMs: number;
  framesOver25MsPct: number;
  framesOver50MsPct: number;
}

export interface PerceptionTask {
  id: string;
  prompt: string;
  completionEvidence: string;
}

export interface GraphBrowserSmokeObservation {
  graphTabSelected: boolean;
  projectIdentityVerified: boolean;
  projectChipExpected: boolean;
  projectVisible: boolean;
  canvas: {
    cssWidth: number;
    cssHeight: number;
    pixelWidth: number;
    pixelHeight: number;
  };
  initial: {
    visualMode: string | null;
    viewPressed: boolean;
    flowLens: string | null;
  };
  dependencies: {
    visualMode: string | null;
    viewPressed: boolean;
    flowLens: string | null;
  };
  keyboardAnnouncement: string;
  restored: {
    visualMode: string | null;
    viewPressed: boolean;
    flowLens: string | null;
  };
  consoleErrors: readonly string[];
  pageErrors: readonly string[];
  failedResponses: ReadonlyArray<{ status: number; url: string }>;
}

export const PERCEPTION_TASKS: readonly PerceptionTask[] = [
  {
    id: 'largest-areas',
    prompt: 'Identifier les trois zones structurelles les plus importantes.',
    completionEvidence: 'Temps, erreurs, réponse et niveau de confiance.',
  },
  {
    id: 'find-symbol',
    prompt: 'Trouver un symbole absent de la vue initiale puis ouvrir son contexte exact.',
    completionEvidence: 'Temps, nombre d’actions, commandes externes et erreurs.',
  },
  {
    id: 'trace-direction',
    prompt: 'Déterminer le sens entrant et sortant d’un flux majeur.',
    completionEvidence: 'Temps, relation annoncée et erreurs de direction.',
  },
  {
    id: 'return-context',
    prompt: 'Revenir au contexte architectural initial après un drill-down.',
    completionEvidence: 'Temps, nombre d’actions et perte de contexte éventuelle.',
  },
  {
    id: 'find-hub-or-dead-code',
    prompt: 'Identifier un hub important ou un candidat de code mort et justifier le choix.',
    completionEvidence: 'Temps, nœud choisi, preuve visible et faux positif éventuel.',
  },
] as const;

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function digestLines(lines: readonly string[]): string {
  const hash = createHash('sha256');
  for (const line of lines) {
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function topologyFingerprint(layout: LayoutLike): TopologyFingerprint {
  const nodeLines = layout.nodes
    .map((node) => {
      if (!Number.isSafeInteger(node.id)) throw new Error(`Invalid graph node id: ${node.id}`);
      return String(node.id);
    })
    .sort((left, right) => Number(left) - Number(right));

  const edgeLines = layout.edges
    .map((edge) => {
      if (!Number.isSafeInteger(edge.source) || !Number.isSafeInteger(edge.target)) {
        throw new Error(`Invalid graph edge endpoints: ${edge.source} -> ${edge.target}`);
      }
      return `${edge.source}\0${edge.target}\0${edge.type}`;
    })
    .sort();

  const returnedNodes = layout.returned_nodes ?? layout.nodes.length;
  const nodeDigest = digestLines(nodeLines);
  const edgeDigest = digestLines(edgeLines);
  return {
    totalNodes: layout.total_nodes,
    returnedNodes,
    returnedEdges: layout.edges.length,
    complete: returnedNodes === layout.total_nodes && layout.nodes.length === layout.total_nodes,
    nodeDigest,
    edgeDigest,
    topologyDigest: digestLines([nodeDigest, edgeDigest]),
  };
}

export function assertSameCompleteTopology(
  leftName: string,
  left: TopologyFingerprint,
  rightName: string,
  right: TopologyFingerprint,
): void {
  if (!left.complete || !right.complete) {
    throw new Error(
      `Strict comparison requires complete layouts: ${leftName}=${left.returnedNodes}/${left.totalNodes}, `
      + `${rightName}=${right.returnedNodes}/${right.totalNodes}`,
    );
  }
  if (left.nodeDigest !== right.nodeDigest || left.edgeDigest !== right.edgeDigest) {
    throw new Error(
      `Topology mismatch: ${leftName}=${left.topologyDigest.slice(0, 12)}, `
      + `${rightName}=${right.topologyDigest.slice(0, 12)}`,
    );
  }
}

/**
 * Fail closed unless the graph that the browser actually rendered is the
 * requested project and the same complete topology as the preflight probe.
 *
 * A separate API fingerprint is insufficient: a stale project-card selector
 * can render another graph while the preflight probe still passes.
 */
export function assertRenderedGraphIdentity(
  variant: string,
  project: string,
  expected: TopologyFingerprint,
  observations: readonly RenderedGraphObservation[],
): RenderedGraphIdentity {
  const rendered = observations.at(-1);
  if (!rendered) {
    throw new Error(`${variant} did not render an /api/layout response`);
  }

  let renderedProject: string | null;
  try {
    const url = new URL(rendered.url);
    if (!url.pathname.endsWith('/api/layout')) {
      throw new Error(`${variant} rendered an unexpected layout URL: ${rendered.url}`);
    }
    renderedProject = url.searchParams.get('project');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${variant} rendered`)) throw error;
    throw new Error(`${variant} rendered an invalid layout URL: ${rendered.url}`, { cause: error });
  }
  if (renderedProject !== project) {
    throw new Error(
      `${variant} rendered project ${JSON.stringify(renderedProject)} instead of ${JSON.stringify(project)}`,
    );
  }

  const topology = topologyFingerprint(rendered.layout);
  assertSameCompleteTopology(`${variant} rendered`, topology, `${variant} preflight`, expected);
  return { url: rendered.url, topology };
}

export function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) throw new Error('Cannot calculate a percentile from an empty sample');
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error(`Percentile ratio must be between 0 and 1: ${ratio}`);
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]!;
}

export function summarizeTimings(values: readonly number[]): TimingSummary {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Timing samples must contain finite non-negative values');
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  const standardDeviation = Math.sqrt(variance);
  return {
    runs: values.length,
    min: round(Math.min(...values)),
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values)),
    mean: round(mean),
    coefficientOfVariationPct: round(mean === 0 ? 0 : (standardDeviation / mean) * 100),
  };
}

export function analyzeFrames(timestamps: readonly number[]): FrameSummary {
  if (timestamps.length < 2) {
    return {
      frameCount: timestamps.length,
      durationMs: 0,
      fps: 0,
      p50FrameMs: 0,
      p95FrameMs: 0,
      framesOver25MsPct: 0,
      framesOver50MsPct: 0,
    };
  }
  const intervals: number[] = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const interval = timestamps[index]! - timestamps[index - 1]!;
    if (Number.isFinite(interval) && interval > 0) intervals.push(interval);
  }
  if (intervals.length === 0) return analyzeFrames([]);
  const durationMs = intervals.reduce((sum, value) => sum + value, 0);
  return {
    frameCount: timestamps.length,
    durationMs: round(durationMs),
    fps: round((intervals.length * 1000) / durationMs),
    p50FrameMs: round(percentile(intervals, 0.5)),
    p95FrameMs: round(percentile(intervals, 0.95)),
    framesOver25MsPct: round((intervals.filter((value) => value > 25).length / intervals.length) * 100),
    framesOver50MsPct: round((intervals.filter((value) => value > 50).length / intervals.length) * 100),
  };
}

export function blindLabels(seed: string): Readonly<Record<'v1' | 'v2', 'A' | 'B'>> {
  const firstByte = createHash('sha256').update(seed).digest()[0]!;
  return firstByte % 2 === 0 ? { v1: 'A', v2: 'B' } : { v1: 'B', v2: 'A' };
}

export function assertGraphBrowserSmoke(observation: GraphBrowserSmokeObservation): void {
  const failures: string[] = [];
  if (!observation.graphTabSelected) failures.push('graph tab is not selected after navigation');
  if (!observation.projectIdentityVerified) {
    failures.push('the successful layout response did not identify the requested project');
  }
  if (observation.projectChipExpected && !observation.projectVisible) {
    failures.push('selected project is not visible in the desktop application shell');
  }
  if (
    observation.canvas.cssWidth < 320
    || observation.canvas.cssHeight < 200
    || observation.canvas.pixelWidth < 320
    || observation.canvas.pixelHeight < 200
  ) {
    failures.push(`graph canvas is not usefully sized (${JSON.stringify(observation.canvas)})`);
  }
  if (
    observation.initial.visualMode !== 'architecture'
    || !observation.initial.viewPressed
    || observation.initial.flowLens !== 'off'
  ) {
    failures.push('Structure view did not mount as the initial active graph');
  }
  if (
    observation.dependencies.visualMode !== 'stellar'
    || !observation.dependencies.viewPressed
    || observation.dependencies.flowLens !== 'semantic-depth-v2'
  ) {
    failures.push('Dependencies view did not activate a keyboard-selected semantic flow');
  }
  if (!/^Node\b/u.test(observation.keyboardAnnouncement)) {
    failures.push(`keyboard traversal did not announce a node (${observation.keyboardAnnouncement || 'empty'})`);
  }
  if (
    observation.restored.visualMode !== 'architecture'
    || !observation.restored.viewPressed
    || observation.restored.flowLens !== 'off'
  ) {
    failures.push('Structure view was not restored after the dependency-flow interaction');
  }
  if (observation.consoleErrors.length > 0) {
    failures.push(`browser console error(s): ${observation.consoleErrors.join(' | ')}`);
  }
  if (observation.pageErrors.length > 0) {
    failures.push(`uncaught page error(s): ${observation.pageErrors.join(' | ')}`);
  }
  if (observation.failedResponses.length > 0) {
    failures.push(`failed HTTP response(s): ${observation.failedResponses
      .map((response) => `${response.status} ${response.url}`)
      .join(' | ')}`);
  }
  if (failures.length > 0) {
    throw new Error(`Packaged Graph UI browser smoke failed:\n- ${failures.join('\n- ')}`);
  }
}
