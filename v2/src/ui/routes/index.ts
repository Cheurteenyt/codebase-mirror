// v2/src/ui/routes/index.ts
// R63: index job routes — trigger V1 index, list job status.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { safeRealpathStrict } from '../../utils/safe-path.js';
import { invalidateGraphStatusCache } from '../../intelligence/graph-status.js';
import { getNotifyHub } from '../notify-hub.js';
import { sendJson, errorMessage, parseJsonBody } from '../helpers.js';
import type { RouteContext, IndexJob } from '../types.js';

/**
 * POST /api/index — trigger a V1 index job (async, returns job ID).
 *
 * R43 (SEC1): validates project_name to prevent CLI argument injection.
 * R44 (B1): inserts '--' before projectName in spawn args.
 * R51 (SEC-7): validates rootPath — leading hyphen + home containment.
 * R51 (SEC-8): clears childPid on exit to prevent stale PID reuse.
 */
export async function routeIndex(
  ctx: RouteContext,
  _url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  _project: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  let rootPath = typeof body.root_path === 'string' ? body.root_path : '';
  const projectName = typeof body.project_name === 'string' ? body.project_name : '';
  if (!rootPath || !projectName) {
    sendJson(res, 400, { error: 'root_path and project_name are required' });
    return;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
    sendJson(res, 400, { error: 'Invalid project name (alphanumeric, dash, underscore only)' });
    return;
  }
  if (projectName.startsWith('-')) {
    sendJson(res, 400, { error: 'Invalid project name (must not start with a hyphen)' });
    return;
  }
  if (rootPath.startsWith('-')) {
    sendJson(res, 400, { error: 'root_path must not start with a hyphen' });
    return;
  }
  const home = homedir();
  let realRootPath: string;
  try {
    realRootPath = safeRealpathStrict(resolve(rootPath));
  } catch {
    sendJson(res, 404, { error: `root_path not found: ${rootPath}` });
    return;
  }
  if (!realRootPath.startsWith(home + sep) && realRootPath !== home) {
    sendJson(res, 403, { error: 'root_path must be inside the user home directory' });
    return;
  }
  rootPath = realRootPath;
  const jobId = `idx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job: IndexJob = { id: jobId, status: 'pending', started_at: new Date().toISOString(), project: projectName };
  ctx.indexJobs.set(jobId, job);
  ctx.log(`Index job started: id=${jobId} project="${projectName}" root="${rootPath}"`);

  try {
    // R80: Bug 14 fix — align with the V1 command format used in benchmarks
    // and CLI reference: `cbm cli index_repository --repo-path <root> --name <project> --mode fast`.
    // The old command `cbm index_repository --project -- <name> <root>` was
    // missing the `cli` subcommand and used wrong flags (--project instead of
    // --name, positional rootPath instead of --repo-path).
    const child = spawn('cbm', ['cli', 'index_repository', '--repo-path', rootPath, '--name', projectName, '--mode', 'fast'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    job.status = 'running';
    // R44 (B2): track the child PID so /api/process-kill can allowlist it.
    job.childPid = child.pid;
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => {
      job.status = 'failed';
      job.error = 'Indexer process failed to start';
      ctx.log(`Index job ${jobId} failed: ${err.message}`);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        job.status = 'completed';
        ctx.log(`Index job ${jobId} completed`);
        // R50 (#1): invalidate the SWR cache so /api/dashboard, /api/graph-status,
        // /api/layout, and get_project_overview serve fresh data immediately.
        invalidateGraphStatusCache(projectName);
        // Notify WebSocket clients that the code graph changed.
        getNotifyHub().notify(projectName, 'code_graph_changed');
      } else {
        job.status = 'failed';
        job.error = `Indexer exited with code ${code}`;
        ctx.log(`Index job ${jobId} failed (exit ${code}): ${stderr.slice(0, 500)}`);
      }
      // R51 (SEC-8): clear childPid to prevent stale PID in process-kill allowlist.
      job.childPid = undefined;
    });
  } catch (e: unknown) {
    job.status = 'failed';
    job.error = 'Indexer process failed to start';
    ctx.log(`Index job ${jobId} failed to start: ${errorMessage(e)}`);
    // R64: if spawn() threw synchronously (e.g. ENOENT when cbm binary is
    // missing), the job never started — return 500 instead of 202. The
    // previous code always sent 202 (Accepted) even for failed-to-start
    // jobs, which was semantically misleading: the client received
    // "accepted, processing" for a job that already failed.
    sendJson(res, 500, { job_id: jobId, status: 'failed', error: job.error });
    return;
  }

  sendJson(res, 202, { job_id: jobId, status: job.status });
}

/**
 * GET /api/index-status — list all index jobs (sorted by started_at desc).
 * Cleans up old completed/failed jobs (keeps last 50).
 */
export async function routeIndexStatus(
  ctx: RouteContext,
  _url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  _project: string,
): Promise<void> {
  const jobs = [...ctx.indexJobs.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
  if (ctx.indexJobs.size > 50) {
    const toKeep = new Set(jobs.slice(0, 50).map((j) => j.id));
    for (const id of ctx.indexJobs.keys()) {
      if (!toKeep.has(id)) ctx.indexJobs.delete(id);
    }
  }
  sendJson(res, 200, { jobs });
}
