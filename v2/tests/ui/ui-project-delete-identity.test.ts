import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';
import { defaultHumanDbPath } from '../../src/human/store.js';
import { pathsReferToSameStore } from '../../src/ui/project-store-registry.js';
import { startUiTestFixture, type UiTestFixture } from '../helpers/ui-server-fixture.js';

describe('UI project deletion store identity', () => {
  let cacheRoot: string;
  let scratchRoot: string;
  let previousCache: string | undefined;
  let fixture: UiTestFixture | undefined;

  beforeEach(() => {
    previousCache = process.env.XDG_CACHE_HOME;
    cacheRoot = mkdtempSync(join(tmpdir(), 'cbm-delete-cache-'));
    scratchRoot = mkdtempSync(join(tmpdir(), 'cbm-delete-identity-'));
    process.env.XDG_CACHE_HOME = cacheRoot;
  });

  afterEach(async () => {
    await fixture?.server.stop();
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    rmSync(cacheRoot, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  it('models case-insensitive and case-sensitive path identities explicitly', () => {
    const upper = join(scratchRoot, 'Project.db');
    const lower = join(scratchRoot, 'project.db');
    expect(pathsReferToSameStore(upper, lower, true)).toBe(true);
    expect(pathsReferToSameStore(upper, lower, false)).toBe(false);
  });

  it('detects aliases by device/inode rather than logical name', () => {
    const original = join(scratchRoot, 'original.db');
    const alias = join(scratchRoot, 'alias.db');
    writeFileSync(original, 'identity');
    linkSync(original, alias);
    expect(pathsReferToSameStore(original, alias, false)).toBe(true);
  });

  it('refuses deletion of every project store opened by the registry', async () => {
    fixture = await startUiTestFixture({ project: 'delete-a' });
    const opened = await fixture.getJson('/api/adr?project=delete-b');
    expect(opened.status).toBe(200);
    const humanPath = defaultHumanDbPath('delete-b');
    expect(existsSync(humanPath)).toBe(true);

    const deletion = await fixture.postJson('/api/project-delete', { name: 'delete-b' });
    expect(deletion.status).toBe(409);
    expect(deletion.body.error).toContain('open store');
    expect(existsSync(humanPath)).toBe(true);
  });

  it('stages the code DB, human DB, and SQLite sidecars before deletion', async () => {
    const project = 'delete-atomic';
    const codePath = defaultCodeDbPath(project);
    const humanPath = defaultHumanDbPath(project);
    mkdirSync(join(codePath, '..'), { recursive: true });
    const paths = [codePath, `${codePath}-wal`, `${codePath}-shm`, humanPath, `${humanPath}-wal`];
    for (const path of paths) writeFileSync(path, 'sqlite');
    fixture = await startUiTestFixture({ project: 'delete-atomic-default' });

    const deletion = await fixture.postJson('/api/project-delete', { name: project });
    expect(deletion.status).toBe(200);
    expect(deletion.body).toMatchObject({ deleted: true, cleanup_pending: false });
    for (const path of paths) expect(existsSync(path)).toBe(false);
  });

  it('validates every store entry before removing either database', async () => {
    const project = 'delete-preflight';
    const codePath = defaultCodeDbPath(project);
    const humanPath = defaultHumanDbPath(project);
    mkdirSync(join(codePath, '..'), { recursive: true });
    writeFileSync(codePath, 'code-db-must-survive');
    mkdirSync(humanPath);
    fixture = await startUiTestFixture({ project: 'delete-preflight-default' });

    const deletion = await fixture.postJson('/api/project-delete', { name: project });
    expect(deletion.status).toBe(500);
    expect(existsSync(codePath)).toBe(true);
    expect(existsSync(humanPath)).toBe(true);
  });
});
