import { describe, expect, it } from 'vitest';
import { graphKeyboardTraversalAction } from '../../scripts/graph-ui-browser-smoke-core.js';

describe('packaged Graph UI browser smoke', () => {
  it('zooms through the exact dependency atlas before requiring a node target', () => {
    expect(graphKeyboardTraversalAction(
      'Open a domain or zoom in for symbols.',
    )).toBe('zoom');
    expect(graphKeyboardTraversalAction(
      'Node runPipeline, 1 of 12. Press Enter to activate.',
    )).toBe('complete');
    expect(graphKeyboardTraversalAction('No visible node targets.')).toBe('retry');
  });
});
