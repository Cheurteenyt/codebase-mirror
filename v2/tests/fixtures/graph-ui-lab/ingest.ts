import type { WorkItem } from './types.js';

export function readSource(id: string): string {
  return `source:${id}`;
}

export function splitTags(source: string): string[] {
  return source.split(':').filter(Boolean);
}

export function ingest(id: string): WorkItem {
  const source = readSource(id);
  return { id, source, score: 0, tags: splitTags(source) };
}
