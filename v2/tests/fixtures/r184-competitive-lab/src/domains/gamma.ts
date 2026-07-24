import { sharedCheckpoint } from '../shared/checkpoint.js';

export function gammaCheckpoint() {
  return sharedCheckpoint('gamma', 3);
}
