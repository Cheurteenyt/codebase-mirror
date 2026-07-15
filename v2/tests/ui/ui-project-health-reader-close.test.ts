import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../src/ui/types.js';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  countNodes: vi.fn(),
  countEdges: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: mocks.existsSync,
  statSync: mocks.statSync,
}));

vi.mock('../../src/bridge/sqlite-ro.js', () => ({
  CodeGraphReader: class {
    countNodes = mocks.countNodes;
    countEdges = mocks.countEdges;
    close = mocks.close;
  },
  defaultCodeDbPath: (name: string) => `/cache/${name}.db`,
}));

import { routeProjectHealth } from '../../src/ui/routes/project.js';

describe('GET /api/project-health reader lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
    mocks.countNodes.mockReturnValue(12);
    mocks.countEdges.mockReturnValue(34);
    mocks.statSync.mockReturnValue({ size: 56 });
  });

  it.each([
    ['countNodes', () => mocks.countNodes.mockImplementationOnce(() => { throw new Error('nodes failed'); })],
    ['countEdges', () => mocks.countEdges.mockImplementationOnce(() => { throw new Error('edges failed'); })],
    ['statSync', () => mocks.statSync.mockImplementationOnce(() => { throw new Error('stat failed'); })],
  ])('closes the reader when %s fails after opening the database', async (_operation, fail) => {
    fail();
    const log = vi.fn();
    const writeHead = vi.fn();
    const end = vi.fn();

    await routeProjectHealth(
      { log } as unknown as RouteContext,
      new URL('http://localhost/api/project-health?name=sample'),
      {} as IncomingMessage,
      { writeHead, end } as unknown as ServerResponse,
      'fallback',
    );

    expect(mocks.close).toHaveBeenCalledOnce();
    expect(writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(JSON.parse(String(end.mock.calls[0]?.[0]))).toEqual({
      name: 'sample',
      status: 'corrupt',
      reason: 'Database health check failed',
    });
    expect(log).toHaveBeenCalledOnce();
  });
});
