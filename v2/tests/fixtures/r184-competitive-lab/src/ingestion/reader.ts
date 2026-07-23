import type { DeliveryEnvelope } from '../contracts/public.js';

export function readEnvelope(serialized: string): DeliveryEnvelope {
  const parsed = JSON.parse(serialized) as DeliveryEnvelope;
  return parsed;
}
