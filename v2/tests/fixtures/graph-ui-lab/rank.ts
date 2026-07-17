import type { StageResult, WorkItem } from './types.js';

export function confidence(score: number): number {
  return Math.min(1, score / 100);
}

export function rankLabel(score: number): string {
  return confidence(score) >= 0.5 ? 'high' : 'normal';
}

export function rank(item: WorkItem): StageResult {
  return {
    stage: 'rank',
    item: { ...item, tags: [...item.tags, rankLabel(item.score)] },
    elapsedMs: 1,
  };
}
