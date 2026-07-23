import type { Analysis, Envelope } from '../shared/types.js';
import { classificationLabel, classifyScore } from './classification.js';
import { scoreEnvelope } from './scoring.js';
import { summarizeEnvelope } from './summarization.js';

export function buildAnalysis(envelope: Envelope): Analysis {
  const score = scoreEnvelope(envelope);
  const category = classifyScore(score);
  return {
    envelope,
    score,
    category,
    summary: `${classificationLabel(category, score)} ${summarizeEnvelope(envelope)}`,
  };
}

export function analysisFingerprint(analysis: Analysis): string {
  return `${analysis.envelope.id}:${analysis.category}:${analysis.score}`;
}
