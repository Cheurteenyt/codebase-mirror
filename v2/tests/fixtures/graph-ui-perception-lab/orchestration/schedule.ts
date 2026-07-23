import type { DeliveryReceipt } from '../shared/types.js';
import { runBatch } from './pipeline.js';

export function scheduleIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

export function executeSchedule(prefix: string, count: number): DeliveryReceipt[] {
  return runBatch(scheduleIds(prefix, count));
}

export function legacyScheduleLabel(prefix: string): string {
  return `legacy:${prefix}`;
}
