import type { Analysis } from '../shared/types.js';

export function formatHeader(analysis: Analysis): string {
  return `[${analysis.category.toUpperCase()}] ${analysis.envelope.id}`;
}

export function formatBody(analysis: Analysis): string {
  return `${analysis.summary}\nscore=${analysis.score}`;
}

export function formatDelivery(analysis: Analysis): string {
  return `${formatHeader(analysis)}\n${formatBody(analysis)}`;
}
