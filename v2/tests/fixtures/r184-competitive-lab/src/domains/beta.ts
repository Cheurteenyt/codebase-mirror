import { sharedCheckpoint } from '../shared/checkpoint.js';

export function betaCheckpoint() {
  return sharedCheckpoint('beta', 2);
}
