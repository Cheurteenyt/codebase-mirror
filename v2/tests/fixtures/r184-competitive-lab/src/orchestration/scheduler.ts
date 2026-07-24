import type { DeliveryEnvelope } from '../contracts/public.js';
import { runPipeline } from './pipeline.js';

export async function schedulePipeline(envelope: DeliveryEnvelope) {
  return runPipeline(envelope);
}
