import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { UiServer } from '../../src/ui/server.js';

describe('UI listen failure lifecycle', () => {
  const blockers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(blockers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
  });

  it('rejects EADDRINUSE and cleans resources instead of reporting a false success', async () => {
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('Missing TCP address');

    const ui = new UiServer({ project: 'bind-failure', port: address.port });
    await expect(ui.start()).rejects.toThrow(/already in use/i);
    await expect(ui.stop()).resolves.toBeUndefined();

    const internals = ui as unknown as {
      wss: unknown;
      hubUnsubscribe: unknown;
      registry: { size: number };
    };
    expect(internals.wss).toBeNull();
    expect(internals.hubUnsubscribe).toBeNull();
    expect(internals.registry.size).toBe(0);
  });

  it('cannot resurrect transports when stop races with asynchronous start', async () => {
    const ui = new UiServer({ project: 'start-stop-race', port: 0 });
    const started = ui.start();
    const stopped = ui.stop();
    const [startResult, stopResult] = await Promise.allSettled([started, stopped]);

    expect(startResult.status).toBe('rejected');
    expect(stopResult.status).toBe('fulfilled');
    const internals = ui as unknown as {
      server: { listening: boolean };
      wss: unknown;
      hubUnsubscribe: unknown;
    };
    expect(internals.server.listening).toBe(false);
    expect(internals.wss).toBeNull();
    expect(internals.hubUnsubscribe).toBeNull();
  });
});
