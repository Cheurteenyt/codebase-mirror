import { randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startUiTestFixture, type UiTestFixture } from '../helpers/ui-server-fixture.js';

function waitForText(socket: Socket, expected: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = '';
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${expected}`)), 2_000);
    const onData = (chunk: Buffer) => {
      received += chunk.toString('latin1');
      if (received.includes(expected)) finish();
    };
    const onClose = () => finish(new Error(`Socket closed before receiving ${expected}`));
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (error) reject(error);
      else resolve(received);
    };
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
    socket.on('error', () => { /* connection reset is an expected forced-close outcome */ });
  });
}

async function openUncooperativeWebSocket(fixture: UiTestFixture): Promise<Socket> {
  const socket = createConnection({ host: '127.0.0.1', port: fixture.port });
  const response = waitForText(socket, '101 Switching Protocols');
  const key = randomBytes(16).toString('base64');
  socket.write([
    `GET /ws?csrf=${encodeURIComponent(fixture.csrfToken)} HTTP/1.1`,
    `Host: 127.0.0.1:${fixture.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    `Origin: ${fixture.baseUrl}`,
    '',
    '',
  ].join('\r\n'));
  try {
    await response;
  } catch (error) {
    socket.destroy();
    throw error;
  }
  // This deliberately remains a raw TCP peer: it never acknowledges the
  // WebSocket close frame sent by UiServer.stop().
  return socket;
}

async function openStalledHttpRequest(fixture: UiTestFixture): Promise<Socket> {
  const socket = createConnection({ host: '127.0.0.1', port: fixture.port });
  const response = waitForText(socket, '100 Continue');
  socket.write([
    'POST /api/adr HTTP/1.1',
    `Host: 127.0.0.1:${fixture.port}`,
    'Content-Type: application/json',
    'Sec-Fetch-Site: none',
    `X-CBM-CSRF: ${fixture.csrfToken}`,
    'Content-Length: 1024',
    'Expect: 100-continue',
    'Connection: keep-alive',
    '',
    '',
  ].join('\r\n'));
  try {
    await response;
  } catch (error) {
    socket.destroy();
    throw error;
  }
  // Leave the declared request body incomplete so http.Server.close() cannot
  // finish without the server's explicit tracked-socket escalation.
  socket.write('{');
  return socket;
}

describe('UI bounded transport shutdown', () => {
  let cacheRoot: string;
  let previousCache: string | undefined;
  let fixture: UiTestFixture | undefined;
  const sockets: Socket[] = [];

  beforeEach(() => {
    previousCache = process.env.XDG_CACHE_HOME;
    cacheRoot = mkdtempSync(join(tmpdir(), 'cbm-ui-shutdown-'));
    process.env.XDG_CACHE_HOME = cacheRoot;
  });

  afterEach(async () => {
    await fixture?.server.stop();
    for (const socket of sockets) socket.destroy();
    sockets.length = 0;
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('terminates a non-cooperative WebSocket and destroys a stalled HTTP socket after grace', async () => {
    const graceMs = 80;
    fixture = await startUiTestFixture({
      project: 'bounded-transport-shutdown',
      transportShutdownGraceMs: graceMs,
      shutdownTimeoutMs: 300,
    });
    const webSocket = await openUncooperativeWebSocket(fixture);
    const httpSocket = await openStalledHttpRequest(fixture);
    sockets.push(webSocket, httpSocket);
    const internals = fixture.server as unknown as {
      server: { once: (event: 'close', listener: () => void) => void };
      wss: { once: (event: 'close', listener: () => void) => void } | null;
    };
    let httpServerClosed = false;
    let webSocketServerClosed = false;
    internals.server.once('close', () => { httpServerClosed = true; });
    internals.wss?.once('close', () => { webSocketServerClosed = true; });
    const webSocketClosed = waitForClose(webSocket);
    const httpSocketClosed = waitForClose(httpSocket);

    const startedAt = performance.now();
    const stopped = fixture.server.stop();
    expect(fixture.server.stop()).toBe(stopped);
    await stopped;
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(graceMs - 20);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(webSocket.destroyed).toBe(true);
    expect(httpSocket.destroyed).toBe(true);
    expect(webSocketServerClosed).toBe(true);
    expect(httpServerClosed).toBe(true);
    await Promise.all([webSocketClosed, httpSocketClosed]);
  });

  it('caps a longer transport grace period at the single global deadline', async () => {
    fixture = await startUiTestFixture({
      project: 'global-shutdown-deadline',
      transportShutdownGraceMs: 10_000,
      shutdownTimeoutMs: 100,
    });
    const httpSocket = await openStalledHttpRequest(fixture);
    sockets.push(httpSocket);
    const httpSocketClosed = waitForClose(httpSocket);

    const startedAt = performance.now();
    await fixture.server.stop();
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(30);
    expect(elapsedMs).toBeLessThan(750);
    await httpSocketClosed;
    expect(httpSocket.destroyed).toBe(true);
  });
});
