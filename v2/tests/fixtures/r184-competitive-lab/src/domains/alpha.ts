import { sharedCheckpoint } from '../shared/checkpoint.js';

export function alphaCheckpoint() {
  return sharedCheckpoint('alpha', 1);
}
