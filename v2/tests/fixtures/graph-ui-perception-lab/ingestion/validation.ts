import type { Envelope } from '../shared/types.js';

export function hasIdentity(envelope: Envelope): boolean {
  return envelope.id.trim().length > 0;
}

export function hasPayload(envelope: Envelope): boolean {
  return envelope.payload.trim().length > 0;
}

export function validateEnvelope(envelope: Envelope): Envelope {
  if (!hasIdentity(envelope) || !hasPayload(envelope)) {
    throw new Error('Invalid envelope');
  }
  return envelope;
}
