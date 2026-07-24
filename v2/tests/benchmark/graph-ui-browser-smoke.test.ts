import { describe, expect, it } from 'vitest';
import {
  graphKeyboardTraversalAction,
  parseGraphBrowserSmokeOptions,
} from '../../scripts/graph-ui-browser-smoke-core.js';

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

  it('accepts explicit desktop and narrow packaged viewports', () => {
    expect(parseGraphBrowserSmokeOptions(['--project', 'demo'])).toMatchObject({
      viewportWidth: 1440,
      viewportHeight: 960,
    });
    expect(parseGraphBrowserSmokeOptions([
      '--project', 'demo',
      '--viewport-width', '380',
      '--viewport-height', '800',
    ])).toMatchObject({
      viewportWidth: 380,
      viewportHeight: 800,
    });
    expect(() => parseGraphBrowserSmokeOptions([
      '--project', 'demo',
      '--viewport-width', '359',
    ])).toThrow('--viewport-width must be an integer between 360 and 3840');
  });
});
