import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  startUiTestFixture,
  waitForJob,
  type UiTestFixture,
} from '../helpers/ui-server-fixture.js';

describe('UI index-child ownership', () => {
  let cacheRoot: string;
  let repoRoot: string;
  let previousCache: string | undefined;
  let fixture: UiTestFixture | undefined;
  let externalChild: ChildProcess | undefined;

  beforeEach(() => {
    previousCache = process.env.XDG_CACHE_HOME;
    cacheRoot = mkdtempSync(join(tmpdir(), 'cbm-child-cache-'));
    repoRoot = mkdtempSync(join(homedir(), 'cbm-child-repo-'));
    process.env.XDG_CACHE_HOME = cacheRoot;
  });

  afterEach(async () => {
    await fixture?.server.stop();
    if (externalChild?.exitCode === null) {
      try { externalChild.kill('SIGKILL'); } catch { /* best effort */ }
    }
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    rmSync(cacheRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('terminates only a running job handle owned by this server', async () => {
    fixture = await startUiTestFixture({
      project: 'owned-child',
      indexJobTerminationGraceMs: 100,
      getIndexerLaunch: () => ({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      }),
    });
    externalChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });

    const accepted = await fixture.postJson('/api/index', {
      root_path: repoRoot,
      project_name: 'owned-child',
    });
    expect(accepted.status).toBe(202);

    const oldEndpoint = await fixture.postJson('/api/process-kill', { pid: externalChild.pid });
    expect(oldEndpoint.status).toBe(404);
    expect(externalChild.exitCode).toBeNull();

    const status = await fixture.getJson('/api/index-status');
    const publicJob = status.body.jobs.find((job: { id: string }) => job.id === accepted.body.job_id);
    expect(publicJob).not.toHaveProperty('child');
    expect(publicJob).not.toHaveProperty('pid');

    const terminate = await fixture.postJson(
      `/api/index-jobs/${encodeURIComponent(accepted.body.job_id)}/terminate`,
      {},
    );
    expect(terminate.status).toBe(202);
    const finalJob = await waitForJob(fixture, accepted.body.job_id);
    expect(finalJob.status).toBe('cancelled');
    expect(externalChild.exitCode).toBeNull();

    const repeated = await fixture.postJson(
      `/api/index-jobs/${encodeURIComponent(accepted.body.job_id)}/terminate`,
      {},
    );
    expect(repeated.status).toBe(409);
  });

  it('does not launch an indexer from a partial request after shutdown begins', async () => {
    let launchCount = 0;
    fixture = await startUiTestFixture({
      project: 'shutdown-race',
      indexJobTerminationGraceMs: 100,
      getIndexerLaunch: () => {
        launchCount += 1;
        return { command: process.execPath, args: ['-e', 'process.exit(0)'] };
      },
    });

    const body = JSON.stringify({ root_path: repoRoot, project_name: 'shutdown-race' });
    const socket = createConnection({ host: '127.0.0.1', port: fixture.port });
    await once(socket, 'connect');
    const responseChunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => responseChunks.push(chunk));

    socket.write([
      'POST /api/index HTTP/1.1',
      `Host: 127.0.0.1:${fixture.port}`,
      'Content-Type: application/json',
      'Sec-Fetch-Site: none',
      `X-CBM-CSRF: ${fixture.csrfToken}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Expect: 100-continue',
      'Connection: close',
      '',
      '',
    ].join('\r\n'));

    // Node sends the interim response only after it has accepted the request;
    // routeIndex is now deterministically suspended in parseJsonBody.
    while (!Buffer.concat(responseChunks).toString('utf8').includes('100 Continue')) {
      await once(socket, 'data');
    }
    const stopped = fixture.server.stop();
    socket.end(body);
    await once(socket, 'close');
    await stopped;

    expect(Buffer.concat(responseChunks).toString('utf8')).toContain('503 Service Unavailable');
    expect(launchCount).toBe(0);
  });

  it('bounds terminal job history without requiring a status request', async () => {
    fixture = await startUiTestFixture({
      project: 'bounded-job-history',
      getIndexerLaunch: () => ({
        command: process.execPath,
        args: ['-e', 'process.exit(1)'],
      }),
    });

    for (let i = 0; i < 55; i++) {
      let accepted: Awaited<ReturnType<UiTestFixture['postJson']>> | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await fixture.postJson('/api/index', {
          root_path: repoRoot,
          project_name: 'bounded-job-history',
        });
        if (response.status === 202) {
          accepted = response;
          break;
        }
        expect([409, 429]).toContain(response.status);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      expect(accepted?.status).toBe(202);
    }

    const internalJobs = (fixture.server as unknown as { indexJobs: Map<string, unknown> }).indexJobs;
    expect(internalJobs.size).toBeLessThanOrEqual(50);
  }, 15_000);
});
