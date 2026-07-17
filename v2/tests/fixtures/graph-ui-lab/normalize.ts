import type { StageResult, WorkItem } from './types.js';

export function normalizeSource(source: string): string {
  return source.trim().toLowerCase();
}

export function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags)].sort();
}

export function normalize(item: WorkItem): StageResult {
  return {
    stage: 'normalize',
    item: { ...item, source: normalizeSource(item.source), tags: uniqueTags(item.tags) },
    elapsedMs: 1,
  };
}
