import type { StageResult, WorkItem } from './types.js';

export function sourceWeight(source: string): number {
  return Math.max(1, source.length);
}

export function tagWeight(tags: string[]): number {
  return tags.reduce((sum, tag) => sum + tag.length, 0);
}

export function analyze(item: WorkItem): StageResult {
  return {
    stage: 'analyze',
    item: { ...item, score: sourceWeight(item.source) + tagWeight(item.tags) },
    elapsedMs: 2,
  };
}
