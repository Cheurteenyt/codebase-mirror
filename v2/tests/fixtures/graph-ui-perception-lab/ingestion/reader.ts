import type { Envelope } from '../shared/types.js';

export function readPayload(id: string): string {
  return `payload:${id}`;
}

export function extractTags(payload: string): string[] {
  return payload.split(':').filter(Boolean);
}

export function readEnvelope(id: string, source = 'fixture'): Envelope {
  const payload = readPayload(id);
  return { id, source, payload, tags: extractTags(payload) };
}
