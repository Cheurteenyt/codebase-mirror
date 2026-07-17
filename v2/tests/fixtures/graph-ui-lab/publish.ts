import type { StageResult, WorkItem } from './types.js';

export function serialize(item: WorkItem): string {
  return JSON.stringify(item);
}

export function checksum(value: string): number {
  return [...value].reduce((sum, character) => sum + character.charCodeAt(0), 0);
}

export function publish(item: WorkItem): StageResult {
  const payload = serialize(item);
  return { stage: `publish:${checksum(payload)}`, item, elapsedMs: 1 };
}
