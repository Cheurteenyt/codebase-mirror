import type { Envelope } from '../shared/types.js';

export function sourceWeight(source: string): number {
  return Math.max(1, source.length);
}

export function payloadWeight(payload: string): number {
  return payload.length * 2;
}

export function tagWeight(tags: string[]): number {
  return tags.reduce((total, tag) => total + tag.length, 0);
}

export function scoreEnvelope(envelope: Envelope): number {
  return sourceWeight(envelope.source)
    + payloadWeight(envelope.payload)
    + tagWeight(envelope.tags);
}
