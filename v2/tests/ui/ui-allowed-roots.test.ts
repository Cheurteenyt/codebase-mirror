import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';
import { startUiTestFixture, type UiTestFixture } from '../helpers/ui-server-fixture.js';

describe('UI repository-root allowlist', () => {
  let cacheRoot: string;
  let previousCache: string | undefined;
  let fixture: UiTestFixture | undefined;

  beforeEach(() => {
    previousCache = process.env.XDG_CACHE_HOME;
    cacheRoot = mkdtempSync(join(tmpdir(), 'cbm-ui-allowed-roots-'));
    process.env.XDG_CACHE_HOME = cacheRoot;
  });

  afterEach(async () => {
    await fixture?.server.stop();
    fixture = undefined;
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it('can browse and reindex the root recorded for the selected project', async () => {
    const project = 'allowed-indexed-root';
    const repositoryRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
    const dbPath = defaultCodeDbPath(project);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE nodes (
          id INTEGER PRIMARY KEY, project TEXT, label TEXT, name TEXT,
          qualified_name TEXT, file_path TEXT, start_line INTEGER,
          end_line INTEGER, properties_json TEXT
        );
        CREATE TABLE edges (
          id INTEGER PRIMARY KEY, project TEXT, source_id INTEGER,
          target_id INTEGER, type TEXT, properties_json TEXT
        );
        CREATE TABLE projects (name TEXT, root_path TEXT);
      `);
      db.prepare('INSERT INTO projects VALUES (?, ?)').run(project, repositoryRoot);
    } finally {
      db.close();
    }

    fixture = await startUiTestFixture({
      project,
      getIndexerLaunch: () => ({ command: process.execPath, args: ['-e', 'process.exit(0)'] }),
    });
    const browse = await fixture.getJson(`/api/browse?path=${encodeURIComponent(repositoryRoot)}`);
    expect(browse.status).toBe(200);
    expect(browse.body.roots).toContain(repositoryRoot);

    const index = await fixture.postJson('/api/index', {
      root_path: repositoryRoot,
      project_name: project,
    });
    expect(index.status).toBe(202);
  });
});
