// v2/src/ui/routes/system.ts
// R63: system routes — filesystem browsing, process management, logs.
// Extracted from server.ts to reduce the main file size and group routes
// by domain. Each route receives a RouteContext with the shared dependencies.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { execSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { safeRealpath } from '../../utils/safe-path.js';
import { sendJson, errorMessage } from '../helpers.js';
import type { RouteContext } from '../types.js';
import { canonicalAllowedRoots, isAllowedFilesystemPath } from '../allowed-roots.js';

/**
 * GET /api/browse — list directories under the user's home directory.
 *
 * R43 (SEC3): restricted to home to prevent filesystem enumeration.
 * R44 (B3): realpathSync before containment check (symlink-safe).
 * R55 (Part A): uses shared safeRealpath utility.
 */
export async function routeBrowse(
  ctx: RouteContext,
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  _project: string,
): Promise<void> {
  const queryPath = url.searchParams.get('path');
  const home = homedir();
  const allowedRoots = canonicalAllowedRoots(ctx.getAllowedRoots());
  let targetPath: string;
  if (queryPath) {
    targetPath = resolve(queryPath);
  } else {
    // Default: home directory
    targetPath = home;
  }
  // R55 (Part A): use the shared safeRealpath helper. The fallback (parent +
  // basename, then resolve()) matches the previous behaviour: a path that
  // doesn't exist yet is still checked against home, then the existsSync
  // check below returns 404.
  const realTargetPath = safeRealpath(targetPath);
  if (!isAllowedFilesystemPath(realTargetPath, allowedRoots)) {
    sendJson(res, 403, { error: 'Browse is restricted to the home directory or configured/indexed repository roots' });
    return;
  }
  // Use the resolved path for the rest of the handler so readdirSync
  // operates on the real directory, not the symlink.
  targetPath = realTargetPath;
  try {
    if (!existsSync(targetPath)) {
      sendJson(res, 404, { error: `Path not found: ${targetPath}` });
      return;
    }
    const stat = statSync(targetPath);
    if (!stat.isDirectory()) {
      sendJson(res, 400, { error: 'Path is not a directory' });
      return;
    }
    const entries = readdirSync(targetPath, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    const roots = allowedRoots;
    const candidateParent = dirname(targetPath) === targetPath ? '' : dirname(targetPath);
    const parent = candidateParent && isAllowedFilesystemPath(candidateParent, allowedRoots)
      ? candidateParent
      : '';
    sendJson(res, 200, {
      path: targetPath,
      dirs,
      roots,
      parent,
    });
  } catch (e: unknown) {
    ctx.log(`Directory browse failed: ${errorMessage(e)}`);
    sendJson(res, 500, { error: 'Unable to list the requested directory' });
  }
}

/**
 * GET /api/processes — list running cbm/cbm-v2 processes.
 *
 * R45 (F7): uses `grep -wE "cbm|cbm-v2"` (whole-word match) to avoid
 * matching every Node.js process on the system.
 */
export async function routeProcesses(
  _ctx: RouteContext,
  _url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  _project: string,
): Promise<void> {
  const currentPid = process.pid;
  const processes: Array<{ pid: number; cpu: number; rss_mb: number; elapsed: string; command: string; is_self: boolean }> = [];
  try {
    // Use `ps` to list processes (Unix only). On Windows, return empty.
    if (process.platform !== 'win32') {
      const output = execSync('ps aux 2>/dev/null | grep -wE "cbm|cbm-v2" | grep -v grep', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const lines = output.split('\n').filter((l) => l.trim().length > 0);
      const seenPids = new Set<number>();
      for (const line of lines.slice(0, 50)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;
        const pid = parseInt(parts[1], 10);
        if (!Number.isFinite(pid)) continue;
        const cpu = parseFloat(parts[2]) || 0;
        const rssKb = parseFloat(parts[5]) || 0;
        const command = parts.slice(10).join(' ').slice(0, 200);
        // Skip the grep process itself and the current ps command
        if (command.includes('grep ')) continue;
        seenPids.add(pid);
        processes.push({
          pid,
          cpu,
          rss_mb: Math.round(rssKb / 1024),
          elapsed: parts[9] || 'unknown',
          command,
          is_self: pid === currentPid,
        });
      }
      // R45 (F7): always include the current UI server process so the
      // ControlTab can display it with is_self=true, even if it wasn't
      // caught by the cbm/cbm-v2 regex (e.g. launched via `node dist/cli.js`).
      if (!seenPids.has(currentPid)) {
        try {
          const selfLine = execSync(`ps -o pid,pcpu,rss,etime,command -p ${currentPid} --no-headers 2>/dev/null`, {
            encoding: 'utf-8',
            timeout: 3000,
          }).trim();
          if (selfLine) {
            const parts = selfLine.trim().split(/\s+/);
            processes.push({
              pid: currentPid,
              cpu: parseFloat(parts[1]) || 0,
              rss_mb: Math.round((parseFloat(parts[2]) || 0) / 1024),
              elapsed: parts[3] || 'unknown',
              command: parts.slice(4).join(' ').slice(0, 200) || `pid ${currentPid}`,
              is_self: true,
            });
          }
        } catch {
          // ps failed for self — skip
        }
      }
    }
  } catch {
    // ps not available or failed — return empty list
  }
  sendJson(res, 200, { processes });
}

/**
 * GET /api/logs — return recent log lines from the in-memory ring buffer.
 */
export async function routeLogs(
  ctx: RouteContext,
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  _project: string,
): Promise<void> {
  const linesParam = url.searchParams.get('lines');
  const lines = linesParam ? Math.min(Math.max(parseInt(linesParam, 10) || 100, 1), 500) : 100;
  const recent = ctx.logBuffer.slice(-lines);
  sendJson(res, 200, { lines: recent });
}
