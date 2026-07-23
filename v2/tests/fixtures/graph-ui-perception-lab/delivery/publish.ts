import type { Analysis, DeliveryReceipt } from '../shared/types.js';
import { formatDelivery } from './format.js';

export function checksum(value: string): number {
  return [...value].reduce((total, character) => total + character.charCodeAt(0), 0);
}

export function selectChannel(analysis: Analysis): string {
  return analysis.category === 'critical' ? 'priority' : 'standard';
}

export function publishAnalysis(analysis: Analysis): DeliveryReceipt {
  const content = formatDelivery(analysis);
  return {
    id: analysis.envelope.id,
    channel: selectChannel(analysis),
    checksum: checksum(content),
  };
}
