import type { Envelope } from '../shared/types.js';

export function normalizeSource(source: string): string {
  return source.trim().toLowerCase();
}

export function compactPayload(payload: string): string {
  return payload.replace(/\s+/gu, ' ').trim();
}

export function joinTags(tags: string[]): string {
  return [...new Set(tags)].sort().join(', ');
}

export function summarizeEnvelope(envelope: Envelope): string {
  return `${normalizeSource(envelope.source)} | ${compactPayload(envelope.payload)} | ${joinTags(envelope.tags)}`;
}
