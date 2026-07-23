import { sharedCheckpoint } from '../shared/checkpoint.js';

export function deltaCheckpoint() {
  return sharedCheckpoint('delta', 4);
}
