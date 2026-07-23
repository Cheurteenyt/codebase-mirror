import type { DeliveryEnvelope } from '../contracts/public.js';

export interface ValidatedEnvelope {
  readonly envelope: DeliveryEnvelope;
  readonly validatedAt: number;
}

export function validateEnvelope(envelope: DeliveryEnvelope): ValidatedEnvelope {
  if (!envelope.id || !envelope.payload) {
    throw new Error('Pipeline envelope must contain an id and payload');
  }
  return { envelope, validatedAt: envelope.attempts };
}
