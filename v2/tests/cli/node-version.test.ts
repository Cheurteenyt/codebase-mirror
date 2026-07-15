import { describe, expect, it } from 'vitest';
import {
  isSupportedNodeVersion,
  MINIMUM_NODE_MAJOR,
  MINIMUM_NODE_MINOR,
  MINIMUM_NODE_PATCH,
  MINIMUM_NODE_VERSION,
} from '../../src/cli/node-version.js';

describe('CLI Node.js runtime contract', () => {
  it('matches the package minimum of Node 22.12.0', () => {
    expect(MINIMUM_NODE_VERSION).toBe('22.12.0');
    expect([MINIMUM_NODE_MAJOR, MINIMUM_NODE_MINOR, MINIMUM_NODE_PATCH]).toEqual([22, 12, 0]);
    expect(isSupportedNodeVersion('v22.12.0')).toBe(true);
    expect(isSupportedNodeVersion('22.12.1')).toBe(true);
    expect(isSupportedNodeVersion('v22.14.0')).toBe(true);
    expect(isSupportedNodeVersion('v24.15.0')).toBe(true);
  });

  it('compares the minor version at the minimum major', () => {
    expect(isSupportedNodeVersion('v22.11.99')).toBe(false);
    expect(isSupportedNodeVersion('v22.12.0')).toBe(true);
    expect(isSupportedNodeVersion('v23.0.0')).toBe(true);
  });

  it('rejects EOL Node releases and malformed or incomplete versions', () => {
    expect(isSupportedNodeVersion('v18.20.8')).toBe(false);
    expect(isSupportedNodeVersion('v20.20.0')).toBe(false);
    expect(isSupportedNodeVersion('v22.11.0')).toBe(false);
    expect(isSupportedNodeVersion('22')).toBe(false);
    expect(isSupportedNodeVersion('22.12')).toBe(false);
    expect(isSupportedNodeVersion('v22.12.0-rc.1')).toBe(false);
    expect(isSupportedNodeVersion('not-a-version')).toBe(false);
    expect(isSupportedNodeVersion('')).toBe(false);
  });
});
