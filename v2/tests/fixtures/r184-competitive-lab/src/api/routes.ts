import type { DeliveryEnvelope } from '../contracts/public.js';
import { runPipeline } from '../orchestration/pipeline.js';

export interface PipelineRequest {
  readonly body: DeliveryEnvelope;
}

export async function runPipelineRoute(request: PipelineRequest) {
  return runPipeline(request.body);
}

export const routeTable = [
  ['POST /pipeline/run', (request: PipelineRequest) => runPipelineRoute(request)],
] as const;
