import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startUiTestFixture, type UiTestFixture } from '../helpers/ui-server-fixture.js';

describe('Graph UI static cache policy', () => {
  let root: string;
  let fixture: UiTestFixture | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cbm-ui-assets-'));
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><script src="/assets/app-AbC123xy.js"></script>');
    writeFileSync(join(root, 'assets', 'app-AbC123xy.js'), 'export const ready = true;');
    writeFileSync(join(root, 'manifest.json'), '{}');
  });

  afterEach(async () => {
    await fixture?.server.stop();
    fixture = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('revalidates entrypoints but caches fingerprinted assets immutably', async () => {
    fixture = await startUiTestFixture({ project: 'static-cache', graphUiPath: root });

    const index = await fetch(`${fixture.baseUrl}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(Number(index.headers.get('content-length'))).toBeGreaterThan(0);

    const asset = await fetch(`${fixture.baseUrl}/assets/app-AbC123xy.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Number(asset.headers.get('content-length'))).toBeGreaterThan(0);

    const manifest = await fetch(`${fixture.baseUrl}/manifest.json`);
    expect(manifest.headers.get('cache-control')).toBe('no-cache');
  });
});
