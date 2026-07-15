import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { startUiTestFixture, type UiTestFixture } from '../helpers/ui-server-fixture.js';

function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
      });
    });
    req.once('error', reject);
    req.end();
  });
}

describe('UI localhost Host/Origin/CSRF boundary', () => {
  let cacheRoot: string;
  let previousCache: string | undefined;
  let fixture: UiTestFixture | undefined;

  beforeEach(() => {
    previousCache = process.env.XDG_CACHE_HOME;
    cacheRoot = mkdtempSync(join(tmpdir(), 'cbm-http-security-'));
    process.env.XDG_CACHE_HOME = cacheRoot;
  });

  afterEach(async () => {
    await fixture?.server.stop();
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('rejects an unexpected Host before dispatch', async () => {
    fixture = await startUiTestFixture({ project: 'host-security' });
    const response = await rawRequest(fixture.port, '/api/bootstrap', { Host: 'evil.example' });
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('Host');
  });

  it('rejects evil Origin + text/plain without performing the mutation', async () => {
    fixture = await startUiTestFixture({ project: 'origin-security' });
    const attack = await fetch(`${fixture.baseUrl}/api/adr`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'text/plain',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ title: 'injected', content: 'x' }),
    });
    expect(attack.status).toBe(403);
    const adr = await fixture.getJson('/api/adr');
    expect(adr.body.has_adr).toBe(false);
  });

  it('requires JSON, fetch-site metadata, and the runtime token', async () => {
    fixture = await startUiTestFixture({ project: 'csrf-security' });

    const noToken = await fetch(`${fixture.baseUrl}/api/adr`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'none',
      },
      body: JSON.stringify({ title: 'missing-token', content: 'x' }),
    });
    expect(noToken.status).toBe(403);

    const badSite = await fixture.postJson('/api/adr', { title: 'bad-site', content: 'x' }, {
      'Sec-Fetch-Site': 'cross-site',
    });
    expect(badSite.status).toBe(403);

    const badType = await fixture.postJson('/api/adr', { title: 'bad-type', content: 'x' }, {
      'Content-Type': 'text/plain',
    });
    expect(badType.status).toBe(403);

    const accepted = await fetch(`${fixture.baseUrl}/api/adr`, {
      method: 'POST',
      headers: {
        Origin: fixture.baseUrl,
        'Content-Type': 'application/json; charset=utf-8',
        'Sec-Fetch-Site': 'same-origin',
        'X-CBM-CSRF': fixture.csrfToken,
      },
      body: JSON.stringify({ title: 'accepted', content: 'safe' }),
    });
    expect(accepted.status).toBe(200);
  });

  it('adds browser hardening headers and exposes no production CORS wildcard', async () => {
    fixture = await startUiTestFixture({ project: 'headers-security' });
    const response = await fixture.getJson('/api/bootstrap');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('allows a Vite origin only when explicitly configured', async () => {
    fixture = await startUiTestFixture({
      project: 'dev-origin',
      devOrigin: 'http://localhost:5173',
    });
    const response = await rawRequest(fixture.port, '/api/bootstrap', {
      Host: 'localhost:5173',
      Origin: 'http://localhost:5173',
    });
    expect(response.status).toBe(200);
  });
});
