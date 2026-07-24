import type { DeliveryReceipt } from '../contracts/public.js';

export function formatReceipt(receipt: DeliveryReceipt): string {
  return `${receipt.receiptId}:${receipt.acceptedScore}`;
}
