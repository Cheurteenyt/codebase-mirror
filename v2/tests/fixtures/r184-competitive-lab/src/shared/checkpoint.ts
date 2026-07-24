export interface Checkpoint {
  readonly domain: string;
  readonly value: number;
}

export function sharedCheckpoint(domain: string, value: number): Checkpoint {
  return { domain, value };
}
