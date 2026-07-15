import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import WebSocket from 'ws';
import { startUiTestFixture, type UiTestFixture } from '../helpers/ui-server-fixture.js';

function websocketOutcome(url: string, origin: string): Promise<{ kind: 'open'; ws: WebSocket } | { kind: 'rejected'; status: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin });
    let settled = false;
    ws.once('open', () => {
      settled = true;
      resolve({ kind: 'open', ws });
    });
    ws.once('unexpected-response', (_request, response) => {
      settled = true;
      response.resume();
      resolve({ kind: 'rejected', status: response.statusCode ?? 0 });
    });
    ws.once('error', () => {
      if (!settled) resolve({ kind: 'rejected', status: 0 });
    });
  });
}

describe('UI WebSocket origin/token boundary', () => {
  let cacheRoot: string;
  let previousCache: string | undefined;
  let fixture: UiTestFixture | undefined;

  beforeEach(() => {
    previousCache = process.env.XDG_CACHE_HOME;
    cacheRoot = mkdtempSync(join(tmpdir(), 'cbm-ws-security-'));
    process.env.XDG_CACHE_HOME = cacheRoot;
  });

  afterEach(async () => {
    await fixture?.server.stop();
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('rejects a missing token and an evil Origin during upgrade', async () => {
    fixture = await startUiTestFixture({ project: 'ws-security' });
    const wsBase = `ws://127.0.0.1:${fixture.port}/ws`;

    const missingToken = await websocketOutcome(wsBase, fixture.baseUrl);
    expect(missingToken.kind).toBe('rejected');

    const evilOrigin = await websocketOutcome(
      `${wsBase}?csrf=${encodeURIComponent(fixture.csrfToken)}`,
      'https://evil.example',
    );
    expect(evilOrigin.kind).toBe('rejected');
  });

  it('accepts same-origin + token and enforces the message-rate bound', async () => {
    fixture = await startUiTestFixture({ project: 'ws-rate' });
    const outcome = await websocketOutcome(
      `ws://127.0.0.1:${fixture.port}/ws?csrf=${encodeURIComponent(fixture.csrfToken)}`,
      fixture.baseUrl,
    );
    expect(outcome.kind).toBe('open');
    if (outcome.kind !== 'open') return;

    const closed = new Promise<number>((resolve) => outcome.ws.once('close', (code) => resolve(code)));
    for (let index = 0; index < 61; index += 1) {
      outcome.ws.send(JSON.stringify({ type: 'ping' }));
    }
    expect(await closed).toBe(1008);
  });
});
