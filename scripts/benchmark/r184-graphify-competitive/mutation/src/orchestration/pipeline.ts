import type { DeliveryEnvelope } from '../contracts/public.js';
import { scoreEnvelope } from '../analysis/scoring.js';
import { commitDelivery } from '../delivery/commit.js';
import { validateEnvelope } from '../ingestion/validation.js';

export async function runPipeline(envelope: DeliveryEnvelope) {
  const validated = validateEnvelope(envelope);
  const score = scoreEnvelope(validated.envelope);
  return commitDelivery(validated.envelope, score);
}
