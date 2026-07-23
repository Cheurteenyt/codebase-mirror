export interface Envelope {
  id: string;
  source: string;
  payload: string;
  tags: string[];
}

export interface Analysis {
  envelope: Envelope;
  score: number;
  category: string;
  summary: string;
}

export interface DeliveryReceipt {
  id: string;
  channel: string;
  checksum: number;
}
