// Index job routes: bounded child-process ownership, status, and termination.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { safeRealpathStrict } from '../../utils/safe-path.js';
import { invalidateGraphStatusCache } from '../../intelligence/graph-status.js';
import { defaultCodeDbPath } from '../../bridge/sqlite-ro.js';
import { getNotifyHub } from '../notify-hub.js';
import { isValidProjectName, pathsReferToSameStore } from '../project-store-registry.js';
import { errorMessage, parseJsonBody } from '../helpers.js';
import type { IndexJob, IndexJobStatus, RouteContext } from '../types.js';
import { canonicalAllowedRoots, isAllowedFilesystemPath } from '../allowed-roots.js';

export const INDEX_STDERR_TAIL_MAX_BYTES = 64 * 1024;
export const INDEX_EXIT_STDERR_DRAIN_GRACE_MS = 50;
export const MAX_RETAINED_INDEX_JOBS = 50;

const TERMINAL_STATUSES = new Set<IndexJobStatus>([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

export function isActiveIndexJob(job: IndexJob): boolean {
  return !TERMINAL_STATUSES.has(job.status);
}

/**
 * Bound retained diagnostics independently of whether a user opens Control or
 * polls the status route. Active jobs are never removed.
 */
export function pruneRetainedIndexJobs(
  ctx: Pick<RouteContext, 'indexJobs'>,
  maxRetained = MAX_RETAINED_INDEX_JOBS,
): void {
  if (ctx.indexJobs.size <= maxRetained) return;
  const activeIds = new Set(
    [...ctx.indexJobs.values()].filter(isActiveIndexJob).map((job) => job.id),
  );
  const terminalToKeep = [...ctx.indexJobs.values()]
    .filter((job) => !activeIds.has(job.id))
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, Math.max(0, maxRetained - activeIds.size));
  const keepIds = new Set([...activeIds, ...terminalToKeep.map((job) => job.id)]);
  for (const id of ctx.indexJobs.keys()) {
    if (!keepIds.has(id)) ctx.indexJobs.delete(id);
  }
}

export function appendBoundedStderrTail(current: string, chunk: Buffer): string {
  const combined = Buffer.concat([Buffer.from(current, 'utf8'), chunk]);
  const tail = combined.length > INDEX_STDERR_TAIL_MAX_BYTES
    ? combined.subarray(combined.length - INDEX_STDERR_TAIL_MAX_BYTES)
    : combined;
  return tail.toString('utf8');
}

function clearJobTimers(job: IndexJob): void {
  if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
  if (job.forceKillTimer) clearTimeout(job.forceKillTimer);
  if (job.exitDrainTimer) clearTimeout(job.exitDrainTimer);
  if (job.treeKillTimeout) clearTimeout(job.treeKillTimeout);
  job.timeoutTimer = undefined;
  job.forceKillTimer = undefined;
  job.exitDrainTimer = undefined;
  job.treeKillTimeout = undefined;
}

function finishJob(job: IndexJob, status: IndexJobStatus, error?: string): boolean {
  if (TERMINAL_STATUSES.has(job.status)) return false;
  clearJobTimers(job);
  job.status = status;
  job.error = error;
  job.child = undefined;
  return true;
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ESRCH';
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    return !isNoSuchProcess(error);
  }
}

function finishTerminatedJob(ctx: RouteContext, job: IndexJob): void {
  if (job.terminationReason === 'timeout') {
    if (finishJob(job, 'timed_out', 'Indexer exceeded the configured timeout')) {
      ctx.log(`Index job ${job.id} timed out`);
    }
    return;
  }
  if (job.terminationReason === 'requested' || job.terminationReason === 'shutdown') {
    if (finishJob(job, 'cancelled', job.error)) {
      ctx.log(`Index job ${job.id} cancelled (${job.terminationReason})`);
    }
    return;
  }
  finishJob(job, 'failed', 'Indexer termination completed without an owned termination request');
}

function failTreeTermination(ctx: RouteContext, job: IndexJob, detail: string): void {
  const child = job.child;
  if (child?.exitCode === null) {
    try { child.kill('SIGKILL'); } catch { /* best-effort direct-child fallback */ }
  }
  finishJob(job, 'failed', `Unable to terminate indexer process tree: ${detail}`);
  ctx.log(`Index job ${job.id} tree termination failed: ${detail}`);
}

/**
 * Windows has no Node.js API for signalling a process group. taskkill's /T
 * traversal is the platform primitive for an owned process tree; /F is
 * intentional because killing the direct parent first can orphan descendants
 * before a later traversal. Arguments are passed directly, never through a
 * command shell.
 */
function forceWindowsProcessTreeTermination(ctx: RouteContext, job: IndexJob): boolean {
  if (job.treeKillInProgress) return true;
  const pid = job.child?.pid;
  if (!pid) {
    failTreeTermination(ctx, job, 'owned child has no process ID');
    return false;
  }

  job.treeKillInProgress = true;
  let settleTreeKill: () => void = () => {};
  job.treeKillPromise = new Promise<void>((resolveTreeKill) => {
    settleTreeKill = resolveTreeKill;
  });

  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const taskkill = systemRoot
    ? resolve(systemRoot, 'System32', 'taskkill.exe')
    : 'taskkill.exe';
  let settled = false;
  const settle = (failure?: string): void => {
    if (settled) return;
    settled = true;
    job.treeKillInProgress = false;
    if (job.treeKillTimeout) clearTimeout(job.treeKillTimeout);
    job.treeKillTimeout = undefined;
    job.treeKiller = undefined;
    if (!TERMINAL_STATUSES.has(job.status)) {
      if (failure) failTreeTermination(ctx, job, failure);
      else finishTerminatedJob(ctx, job);
    }
    settleTreeKill();
  };

  try {
    const killer = spawn(
      taskkill,
      ['/PID', String(pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    );
    job.treeKiller = killer;
    const killerTimeoutMs = Math.max(1_000, Math.min(5_000, ctx.indexJobTerminationGraceMs * 2));
    job.treeKillTimeout = setTimeout(() => {
      try { killer.kill('SIGKILL'); } catch { /* best effort */ }
      settle(`taskkill timed out after ${killerTimeoutMs}ms`);
    }, killerTimeoutMs);
    job.treeKillTimeout.unref();
    killer.once('error', (error) => settle(errorMessage(error)));
    killer.once('close', (code, signal) => {
      if (code === 0) {
        settle();
        return;
      }
      const result = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`;
      settle(`taskkill failed with ${result}`);
    });
  } catch (error: unknown) {
    settle(errorMessage(error));
    return false;
  }
  return true;
}

/** Force-stop the complete process tree owned by an index job. */
export function forceIndexJobTermination(ctx: RouteContext, job: IndexJob): boolean {
  if (!isActiveIndexJob(job) || !job.child) return false;
  if (job.forceKillTimer) {
    clearTimeout(job.forceKillTimer);
    job.forceKillTimer = undefined;
  }

  if (process.platform === 'win32') {
    return forceWindowsProcessTreeTermination(ctx, job);
  }

  const pid = job.child.pid;
  if (!pid) {
    failTreeTermination(ctx, job, 'owned child has no process ID');
    return false;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error: unknown) {
    if (!isNoSuchProcess(error)) {
      failTreeTermination(ctx, job, errorMessage(error));
      return false;
    }
  }
  finishTerminatedJob(ctx, job);
  return true;
}

/**
 * Terminate only the ChildProcess handle owned by this server instance. No PID
 * supplied by a client is ever accepted or looked up.
 */
export function requestIndexJobTermination(
  ctx: RouteContext,
  job: IndexJob,
  reason: 'requested' | 'timeout' | 'shutdown',
): boolean {
  if (!isActiveIndexJob(job) || !job.child || job.status === 'terminating') return false;

  job.terminationReason = reason;
  job.status = 'terminating';
  if (reason === 'timeout') job.error = 'Indexer exceeded the configured timeout';
  if (reason === 'shutdown') job.error = 'UI server is shutting down';

  if (process.platform === 'win32') {
    return forceWindowsProcessTreeTermination(ctx, job);
  }

  const pid = job.child.pid;
  if (!pid) {
    failTreeTermination(ctx, job, 'owned child has no process ID');
    return false;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error: unknown) {
    if (isNoSuchProcess(error)) {
      finishTerminatedJob(ctx, job);
      return true;
    }
    failTreeTermination(ctx, job, errorMessage(error));
    return false;
  }

  job.forceKillTimer = setTimeout(() => {
    forceIndexJobTermination(ctx, job);
  }, ctx.indexJobTerminationGraceMs);
  job.forceKillTimer.unref();
  return true;
}

/** POST /api/index - trigger a bounded asynchronous index job. */
export async function routeIndex(
  ctx: RouteContext,
  _url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  _project: string,
): Promise<void> {
  if (ctx.isStopping()) {
    ctx.sendJson(res, 503, { error: 'UI server is shutting down' });
    return;
  }
  const body = await parseJsonBody(req);
  if (!body) {
    ctx.sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  // parseJsonBody is asynchronous. Shutdown may have begun while this request
  // was suspended waiting for the remaining bytes.
  if (ctx.isStopping()) {
    ctx.sendJson(res, 503, { error: 'UI server is shutting down' });
    return;
  }
  let rootPath = typeof body.root_path === 'string' ? body.root_path : '';
  let projectName = typeof body.project_name === 'string' ? body.project_name : '';
  if (!rootPath || !projectName) {
    ctx.sendJson(res, 400, { error: 'root_path and project_name are required' });
    return;
  }
  if (projectName.startsWith('-')) {
    ctx.sendJson(res, 400, { error: 'Invalid project name: project_name must not start with a hyphen' });
    return;
  }
  if (!isValidProjectName(projectName)) {
    ctx.sendJson(res, 400, { error: 'Invalid project name for cross-platform storage' });
    return;
  }
  projectName = ctx.resolveProjectName(projectName);
  if (rootPath.startsWith('-')) {
    ctx.sendJson(res, 400, { error: 'root_path must not start with a hyphen' });
    return;
  }

  try {
    rootPath = safeRealpathStrict(resolve(rootPath));
  } catch {
    ctx.sendJson(res, 404, { error: `root_path not found: ${rootPath}` });
    return;
  }
  const allowedRoots = canonicalAllowedRoots(ctx.getAllowedRoots());
  if (!isAllowedFilesystemPath(rootPath, allowedRoots)) {
    ctx.sendJson(res, 403, { error: 'root_path must be inside a configured or indexed repository root' });
    return;
  }

  const activeJobs = [...ctx.indexJobs.values()].filter(isActiveIndexJob);
  if (activeJobs.length >= ctx.maxConcurrentIndexJobs) {
    ctx.sendJson(res, 429, { error: 'Maximum number of concurrent index jobs reached' });
    return;
  }
  const activeForProject = activeJobs.filter((job) => pathsReferToSameStore(
    defaultCodeDbPath(job.project),
    defaultCodeDbPath(projectName),
  ));
  if (activeForProject.some((job) => job.rootPath === rootPath)) {
    ctx.sendJson(res, 409, { error: 'An identical index job is already running' });
    return;
  }
  if (activeForProject.length >= ctx.maxConcurrentIndexJobsPerProject) {
    ctx.sendJson(res, 429, { error: 'Maximum number of index jobs for this project reached' });
    return;
  }

  let launch: { command: string; args: string[] };
  try {
    launch = ctx.getIndexerLaunch(rootPath, projectName);
  } catch (error: unknown) {
    ctx.log(`Index job failed to prepare: ${errorMessage(error)}`);
    ctx.sendJson(res, 500, { error: 'Indexer process failed to start' });
    return;
  }
  // Keep the final guard adjacent to job publication/spawn. Once it passes,
  // there is no asynchronous gap before the child handle enters indexJobs.
  if (ctx.isStopping()) {
    ctx.sendJson(res, 503, { error: 'UI server is shutting down' });
    return;
  }

  const jobId = `idx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job: IndexJob = {
    id: jobId,
    status: 'pending',
    started_at: new Date().toISOString(),
    project: projectName,
    rootPath,
    stderrTail: '',
  };
  ctx.indexJobs.set(jobId, job);
  pruneRetainedIndexJobs(ctx);
  ctx.log(`Index job started: id=${jobId} project="${projectName}" root="${rootPath}"`);

  try {
    const child = spawn(
      launch.command,
      launch.args,
      {
        // stdout is intentionally ignored so an unconsumed pipe cannot block
        // the child. stderr is drained into a bounded diagnostic tail.
        stdio: ['ignore', 'ignore', 'pipe'],
        // POSIX descendants inherit this dedicated process group, allowing
        // termination to target the complete tree. Windows uses taskkill /T.
        detached: process.platform !== 'win32',
        windowsHide: true,
      },
    );
    job.child = child;
    job.status = 'running';

    child.stderr?.on('data', (chunk: Buffer) => {
      job.stderrTail = appendBoundedStderrTail(job.stderrTail, chunk);
    });

    child.once('error', (error) => {
      if (finishJob(job, 'failed', 'Indexer process failed to start')) {
        ctx.log(`Index job ${jobId} failed: ${error.message}`);
      }
    });

    const finalizeExitedChild = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (TERMINAL_STATUSES.has(job.status)) return;

      // `exit` only means the direct child is gone. A descendant can retain an
      // inherited stderr descriptor indefinitely, preventing `close` and
      // otherwise keeping this job (and its concurrency slot) active. Give
      // already-buffered diagnostics a short drain window, then release the
      // pipe and finalize from the direct child's exit result.
      child.stderr?.destroy();

      if (job.terminationReason) {
        // taskkill reports completion only after its tree traversal. On POSIX,
        // retain the force timer while any member of the dedicated group is
        // alive; otherwise a fast-exiting parent could orphan a descendant
        // that ignored SIGTERM.
        if (job.treeKillInProgress) return;
        if (process.platform !== 'win32'
          && job.forceKillTimer
          && child.pid
          && isPosixProcessGroupAlive(child.pid)) return;
        finishTerminatedJob(ctx, job);
        return;
      }
      if (code !== 0) {
        const detail = job.stderrTail.slice(-500);
        const exitDescription = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
        if (finishJob(job, 'failed', `Indexer exited with ${exitDescription}`)) {
          ctx.log(`Index job ${jobId} failed (${exitDescription}): ${detail}`);
        }
        return;
      }

      try {
        ctx.refreshCodeReader(projectName);
      } catch (error: unknown) {
        const diagnostic = `Index completed, but the code graph could not be opened: ${errorMessage(error)}`;
        if (finishJob(job, 'failed', diagnostic)) ctx.log(`Index job ${jobId} unusable: ${diagnostic}`);
        return;
      }

      if (finishJob(job, 'completed')) {
        invalidateGraphStatusCache(projectName);
        getNotifyHub().notify(projectName, 'code_graph_changed');
        ctx.log(`Index job ${jobId} completed and reader refreshed`);
      }
    };

    child.once('exit', (code, signal) => {
      if (TERMINAL_STATUSES.has(job.status) || job.exitDrainTimer) return;
      job.exitDrainTimer = setTimeout(() => {
        job.exitDrainTimer = undefined;
        finalizeExitedChild(code, signal);
      }, INDEX_EXIT_STDERR_DRAIN_GRACE_MS);
      job.exitDrainTimer.unref();
    });

    child.once('close', (code, signal) => {
      finalizeExitedChild(code, signal);
    });

    job.timeoutTimer = setTimeout(() => {
      requestIndexJobTermination(ctx, job, 'timeout');
    }, ctx.indexJobTimeoutMs);
    job.timeoutTimer.unref();
  } catch (error: unknown) {
    finishJob(job, 'failed', 'Indexer process failed to start');
    ctx.log(`Index job ${jobId} failed to start: ${errorMessage(error)}`);
    ctx.sendJson(res, 500, { job_id: jobId, status: job.status, error: job.error });
    return;
  }

  ctx.sendJson(res, 202, { job_id: jobId, status: job.status });
}

/** POST /api/index-jobs/<jobId>/terminate - terminate an owned running job. */
export async function routeIndexJobTerminate(
  ctx: RouteContext,
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  _project: string,
): Promise<void> {
  const match = /^\/api\/index-jobs\/([^/]+)\/terminate$/.exec(url.pathname);
  let jobId: string;
  try {
    jobId = match ? decodeURIComponent(match[1]) : '';
  } catch {
    ctx.sendJson(res, 400, { error: 'Invalid index job ID' });
    return;
  }
  const job = ctx.indexJobs.get(jobId);
  if (!job) {
    ctx.sendJson(res, 404, { error: 'Index job not found' });
    return;
  }
  if (!job.child || job.status !== 'running') {
    ctx.sendJson(res, 409, { error: 'Index job is not running' });
    return;
  }
  if (!requestIndexJobTermination(ctx, job, 'requested')) {
    ctx.sendJson(res, 409, { error: 'Index job could not be terminated' });
    return;
  }
  ctx.log(`Index job termination requested: id=${jobId}`);
  ctx.sendJson(res, 202, { job_id: jobId, status: job.status });
}

/** GET /api/index-status - return serializable job state, newest first. */
export async function routeIndexStatus(
  ctx: RouteContext,
  _url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  _project: string,
): Promise<void> {
  pruneRetainedIndexJobs(ctx);
  const jobs = [...ctx.indexJobs.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  ctx.sendJson(res, 200, {
    jobs: jobs.slice(0, MAX_RETAINED_INDEX_JOBS).map((job) => ({
      id: job.id,
      status: job.status,
      error: job.error,
      started_at: job.started_at,
      project: job.project,
    })),
  });
}
