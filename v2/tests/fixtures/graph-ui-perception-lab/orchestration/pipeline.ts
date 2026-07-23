import { analysisFingerprint, buildAnalysis } from '../analysis/analyzer.js';
import { publishAnalysis } from '../delivery/publish.js';
import { readEnvelope } from '../ingestion/reader.js';
import { validateEnvelope } from '../ingestion/validation.js';
import type { DeliveryReceipt } from '../shared/types.js';

export function runPipeline(id: string): DeliveryReceipt {
  const envelope = validateEnvelope(readEnvelope(id));
  const analysis = buildAnalysis(envelope);
  analysisFingerprint(analysis);
  return publishAnalysis(analysis);
}

export function runBatch(ids: string[]): DeliveryReceipt[] {
  return ids.map((id) => runPipeline(id));
}
