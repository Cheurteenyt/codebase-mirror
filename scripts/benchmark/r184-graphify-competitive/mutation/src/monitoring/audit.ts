import { commitDelivery } from '../delivery/commit.js';
import type { DeliveryEnvelope } from '../contracts/public.js';

export async function auditDelivery(envelope: DeliveryEnvelope) {
  return commitDelivery(envelope, 100);
}
