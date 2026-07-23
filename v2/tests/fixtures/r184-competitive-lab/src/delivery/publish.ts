import type {
  DeliveryReceipt,
  PipelineEnvelope,
} from '../contracts/envelope.js';

export async function commitDelivery(
  envelope: PipelineEnvelope,
  acceptedScore: number,
): Promise<DeliveryReceipt> {
  return {
    receiptId: `receipt:${envelope.id}`,
    acceptedScore,
  };
}
