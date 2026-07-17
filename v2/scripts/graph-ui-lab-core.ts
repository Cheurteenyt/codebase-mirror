import { createHash } from 'node:crypto';

export const GRAPH_UI_LAB_VERSION = 1 as const;

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
