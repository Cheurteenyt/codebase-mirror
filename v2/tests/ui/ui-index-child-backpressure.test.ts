import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
  appendBoundedStderrTail,
  INDEX_STDERR_TAIL_MAX_BYTES,
} from '../../src/ui/routes/index.js';
import {
  startUiTestFixture,
  waitForJob,
  type UiTestFixture,
} from '../helpers/ui-server-fixture.js';

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe('UI index-child backpressure and lifecycle bounds', () => {
  let cacheRoot: string;
  let repoRoot: string;
  let otherRepoRoot: string;
  let scratchRoot: string;
  let previousCache: string | undefined;
  let fixture: UiTestFixture | undefined;
  let descendantPidFiles: string[];

  beforeEach(() => {
    previousCache = process.env.XDG_CACHE_HOME;
    cacheRoot = mkdtempSync(join(tmpdir(), 'cbm-backpressure-cache-'));
    scratchRoot = mkdtempSync(join(tmpdir(), 'cbm-backpressure-scratch-'));
    repoRoot = mkdtempSync(join(homedir(), 'cbm-backpressure-repo-'));
    otherRepoRoot = mkdtempSync(join(homedir(), 'cbm-backpressure-other-'));
    descendantPidFiles = [];
    process.env.XDG_CACHE_HOME = cacheRoot;
  });

  afterEach(async () => {
    await fixture?.server.stop();
    for (const pidFile of descendantPidFiles) {
      if (!existsSync(pidFile)) continue;
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* already exited */ }
    }
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    for (const path of [cacheRoot, scratchRoot, repoRoot, otherRepoRoot]) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('keeps only a bounded stderr tail in bytes', () => {
    let tail = '';
    for (let index = 0; index < 8; index += 1) {
      tail = appendBoundedStderrTail(tail, Buffer.alloc(256 * 1024, 97 + index));
    }
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(INDEX_STDERR_TAIL_MAX_BYTES);
    expect(tail).toContain('h');
    expect(tail).not.toContain('a');
  });

  it('drains bounded stderr and ignores massive stdout without hanging', async () => {
    fixture = await startUiTestFixture({
      project: 'backpressure-child',
      getIndexerLaunch: () => ({
        command: process.execPath,
        args: [
          '-e',
          "for(let i=0;i<16;i++)process.stdout.write('x'.repeat(1024*1024));"
            + "process.stderr.write('e'.repeat(2*1024*1024));process.exitCode=7",
        ],
      }),
    });
    const accepted = await fixture.postJson('/api/index', {
      root_path: repoRoot,
      project_name: 'backpressure-child',
    });
    const job = await waitForJob(fixture, accepted.body.job_id, undefined, 10_000);
    expect(job.status).toBe('failed');
    expect(job.error).toContain('code 7');
    const logs = await fixture.getJson('/api/logs?lines=10');
    expect(Math.max(...logs.body.lines.map((line: string) => line.length))).toBeLessThan(1_000);
  });

  it('finalizes from exit when a descendant keeps the stderr pipe open', async () => {
    const descendantPidFile = join(scratchRoot, 'stderr-descendant.pid');
    descendantPidFiles.push(descendantPidFile);
    fixture = await startUiTestFixture({
      project: 'exit-with-open-pipe',
      getIndexerLaunch: () => ({
        command: process.execPath,
        args: [
          '-e',
          "const{spawn}=require('node:child_process');"
            + "const{writeFileSync}=require('node:fs');"
            + "const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],"
            + "{stdio:['ignore','ignore',2],windowsHide:true});"
            + "writeFileSync(process.argv[1],String(child.pid));child.unref();"
            + "process.stderr.write('retained-pipe-diagnostic');process.exitCode=7",
          descendantPidFile,
        ],
      }),
    });

    const accepted = await fixture.postJson('/api/index', {
      root_path: repoRoot,
      project_name: 'exit-with-open-pipe',
    });
    const startedAt = Date.now();
    const job = await waitForJob(fixture, accepted.body.job_id, undefined, 2_000);

    expect(job.status).toBe('failed');
    expect(job.error).toContain('code 7');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const logs = await fixture.getJson('/api/logs?lines=10');
    expect(logs.body.lines.join('\n')).toContain('retained-pipe-diagnostic');
  });

  it('enforces concurrency and a job timeout', async () => {
    fixture = await startUiTestFixture({
      project: 'timeout-child',
      indexJobTimeoutMs: 100,
      indexJobTerminationGraceMs: 50,
      maxConcurrentIndexJobs: 1,
      getIndexerLaunch: () => ({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      }),
    });
    const first = await fixture.postJson('/api/index', {
      root_path: repoRoot,
      project_name: 'timeout-child',
    });
    expect(first.status).toBe(202);
    const duplicate = await fixture.postJson('/api/index', {
      root_path: repoRoot,
      project_name: 'timeout-child',
    });
    expect(duplicate.status).toBe(429);
    const another = await fixture.postJson('/api/index', {
      root_path: otherRepoRoot,
      project_name: 'another-child',
    });
    expect(another.status).toBe(429);
    const job = await waitForJob(fixture, first.body.job_id);
    expect(job.status).toBe('timed_out');
  });

  it('terminates a stubborn descendant together with its owned indexer parent', async () => {
    const descendantPidFile = join(scratchRoot, 'terminated-descendant.pid');
    descendantPidFiles.push(descendantPidFile);
    fixture = await startUiTestFixture({
      project: 'tree-termination-child',
      indexJobTerminationGraceMs: 100,
      getIndexerLaunch: () => ({
        command: process.execPath,
        args: [
          '-e',
          "const{spawn}=require('node:child_process');"
            + "const{writeFileSync}=require('node:fs');"
            + "const descendant=spawn(process.execPath,['-e',"
            + "'process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'],"
            + "{stdio:'ignore',windowsHide:true});"
            + "writeFileSync(process.argv[1],String(descendant.pid));"
            + "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
          descendantPidFile,
        ],
      }),
    });

    const accepted = await fixture.postJson('/api/index', {
      root_path: repoRoot,
      project_name: 'tree-termination-child',
    });
    expect(accepted.status).toBe(202);
    const deadline = Date.now() + 3_000;
    while (!existsSync(descendantPidFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(descendantPidFile)).toBe(true);
    const descendantPid = Number(readFileSync(descendantPidFile, 'utf8'));

    const terminate = await fixture.postJson(
      `/api/index-jobs/${encodeURIComponent(accepted.body.job_id)}/terminate`,
      {},
    );
    expect(terminate.status).toBe(202);
    const job = await waitForJob(fixture, accepted.body.job_id);

    expect(job.status).toBe('cancelled');
    expect(await waitForProcessExit(descendantPid)).toBe(true);
  });

  it('terminates an owned process tree during bounded server shutdown', async () => {
    const pidFile = join(scratchRoot, 'child.pid');
    const descendantPidFile = join(scratchRoot, 'shutdown-descendant.pid');
    descendantPidFiles.push(descendantPidFile);
    fixture = await startUiTestFixture({
      project: 'shutdown-child',
      indexJobTerminationGraceMs: 50,
      getIndexerLaunch: () => ({
        command: process.execPath,
        args: [
          '-e',
          "const{spawn}=require('node:child_process');"
            + "const{writeFileSync}=require('node:fs');"
            + "const descendant=spawn(process.execPath,['-e',"
            + "'process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'],"
            + "{stdio:'ignore',windowsHide:true});"
            + "writeFileSync(process.argv[1],String(process.pid));"
            + "writeFileSync(process.argv[2],String(descendant.pid));"
            + "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
          pidFile,
          descendantPidFile,
        ],
      }),
    });
    const accepted = await fixture.postJson('/api/index', {
      root_path: repoRoot,
      project_name: 'shutdown-child',
    });
    expect(accepted.status).toBe(202);
    const deadline = Date.now() + 3_000;
    while ((!existsSync(pidFile) || !existsSync(descendantPidFile)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(pidFile)).toBe(true);
    expect(existsSync(descendantPidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const descendantPid = Number(readFileSync(descendantPidFile, 'utf8'));

    await fixture.server.stop();
    expect(await waitForProcessExit(pid)).toBe(true);
    expect(await waitForProcessExit(descendantPid)).toBe(true);
  });
});
