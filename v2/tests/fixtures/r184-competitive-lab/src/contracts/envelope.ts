export interface PipelineEnvelope {
  readonly id: string;
  readonly attempts: number;
  readonly payload: string;
}

export type PipelineEnvelopeAlias = PipelineEnvelope;

export interface DeliveryReceipt {
  readonly receiptId: string;
  readonly acceptedScore: number;
}
