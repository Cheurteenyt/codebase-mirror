import type { PipelineEnvelopeAlias } from '../contracts/public.js';

export function scoreEnvelope(envelope: PipelineEnvelopeAlias): number {
  return Math.max(0, 100 - envelope.attempts * 10);
}
