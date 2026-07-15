import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { defaultCodeDbPath } from '../../src/bridge/sqlite-ro.js';
import {
  createMinimalCodeDb,
  startUiTestFixture,
  waitForJob,
  type UiTestFixture,
} from '../helpers/ui-server-fixture.js';

describe('UI code-reader refresh after index', () => {
  let cacheRoot: string;
  let repoRoot: string;
  let scratchRoot: string;
  let previousCache: string | undefined;
  let fixture: UiTestFixture | undefined;

  beforeEach(() => {
    previousCache = process.env.XDG_CACHE_HOME;
    cacheRoot = mkdtempSync(join(tmpdir(), 'cbm-reader-cache-'));
    scratchRoot = mkdtempSync(join(tmpdir(), 'cbm-reader-template-'));
    repoRoot = mkdtempSync(join(homedir(), 'cbm-reader-repo-'));
    process.env.XDG_CACHE_HOME = cacheRoot;
  });

  afterEach(async () => {
    await fixture?.server.stop();
    fixture = undefined;
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    for (const path of [cacheRoot, scratchRoot, repoRoot]) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('opens the newly created DB without restarting the server', async () => {
    const project = 'reader-refresh';
    const templateDb = join(scratchRoot, 'template.db');
    const targetDb = defaultCodeDbPath(project);
    createMinimalCodeDb(templateDb, project, 'fresh-node');

    fixture = await startUiTestFixture({
      project,
      getIndexerLaunch: () => ({
        command: process.execPath,
        args: [
          '-e',
          "const fs=require('node:fs'),p=require('node:path');fs.mkdirSync(p.dirname(process.argv[2]),{recursive:true});fs.copyFileSync(process.argv[1],process.argv[2])",
          templateDb,
          targetDb,
        ],
      }),
    });

    expect((await fixture.getJson('/api/layout')).status).toBe(404);
    const accepted = await fixture.postJson('/api/index', {
      root_path: repoRoot,
      project_name: project,
    });
    expect(accepted.status).toBe(202);
    const job = await waitForJob(fixture, accepted.body.job_id);
    expect(job.status).toBe('completed');

    const layout = await fixture.getJson('/api/layout');
    expect(layout.status).toBe(200);
    expect(layout.body.nodes[0].name).toBe('fresh-node');
  });

  it('does not announce a completed/usable graph when reopening fails', async () => {
    const project = 'reader-invalid';
    const invalidDb = join(scratchRoot, 'invalid.db');
    writeFileSync(invalidDb, 'not a sqlite database');

    fixture = await startUiTestFixture({
      project,
      getIndexerLaunch: () => ({
        command: process.execPath,
        args: [
          '-e',
          "const fs=require('node:fs'),p=require('node:path');fs.mkdirSync(p.dirname(process.argv[2]),{recursive:true});fs.copyFileSync(process.argv[1],process.argv[2])",
          invalidDb,
          defaultCodeDbPath(project),
        ],
      }),
    });
    const accepted = await fixture.postJson('/api/index', {
      root_path: repoRoot,
      project_name: project,
    });
    const job = await waitForJob(fixture, accepted.body.job_id);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('could not be opened');
    expect((await fixture.getJson('/api/layout')).status).toBe(404);
  });
});
