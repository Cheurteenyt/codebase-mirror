import { analyze } from './analyze.js';
import { ingest } from './ingest.js';
import { normalize } from './normalize.js';
import { publish } from './publish.js';
import { rank } from './rank.js';
import type { StageResult } from './types.js';

export function runPipeline(id: string): StageResult[] {
  const first = normalize(ingest(id)).item;
  const second = analyze(first).item;
  const third = rank(second).item;
  return [
    { stage: 'ingest', item: ingest(id), elapsedMs: 1 },
    normalize(ingest(id)),
    analyze(first),
    rank(second),
    publish(third),
  ];
}

export function totalElapsed(results: StageResult[]): number {
  return results.reduce((sum, result) => sum + result.elapsedMs, 0);
}
