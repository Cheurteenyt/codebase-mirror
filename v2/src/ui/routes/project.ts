// v2/src/ui/routes/project.ts
// R63: project management routes — list, health, delete.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CodeGraphReader, defaultCodeDbPath } from '../../bridge/sqlite-ro.js';
import { defaultHumanDbPath } from '../../human/store.js';
import { sendJson, errorMessage, parseJsonBody } from '../helpers.js';
import type { RouteContext } from '../types.js';

/**
 * GET /api/projects — list indexed projects with health info.
 */
export async function routeProjects(
  _ctx: RouteContext,
  _url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  _project: string,
): Promise<void> {
  const projects: Array<{
    name: string;
    root_path: string;
    indexed_at: string;
    node_count?: number;
    edge_count?: number;
    size_bytes?: number;
    status?: string;
  }> = [];
  const cacheDir = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const cbmDir = join(cacheDir, 'codebase-memory-mcp');
  if (existsSync(cbmDir)) {
    const files = readdirSync(cbmDir);
    for (const f of files) {
      if (f.endsWith('.db') && !f.endsWith('.human.db') && !f.startsWith('_')) {
        const name = f.replace(/\.db$/, '');
        const dbPath = join(cbmDir, f);
        const stat = statSync(dbPath);
        let nodeCount: number | undefined;
        let edgeCount: number | undefined;
        let status = 'healthy';
        let reader: CodeGraphReader | undefined;
        try {
          reader = new CodeGraphReader(dbPath);
          const counts = reader.countAll(name);
          nodeCount = counts.nodes;
          edgeCount = counts.edges;
        } catch {
          status = 'corrupt';
        } finally {
          reader?.close();
        }
        projects.push({
          name,
          root_path: '',
          indexed_at: stat.mtime.toISOString(),
          node_count: nodeCount,
          edge_count: edgeCount,
          size_bytes: stat.size,
          status,
        });
      }
    }
  }
  sendJson(res, 200, { projects });
}

/**
 * GET /api/project-health — check DB integrity.
 * R45 (F6/SEC4): validates name against regex to prevent path traversal.
 */
export async function routeProjectHealth(
  ctx: RouteContext,
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  project: string,
): Promise<void> {
  const name = url.searchParams.get('name') ?? project;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || name.startsWith('-')) {
    sendJson(res, 400, { error: 'Invalid project name (alphanumeric, dash, underscore only, no leading hyphen)' });
    return;
  }
  const dbPath = defaultCodeDbPath(name);
  if (!existsSync(dbPath)) {
    sendJson(res, 200, { name, status: 'missing', reason: 'DB file not found' });
    return;
  }
  try {
    const reader = new CodeGraphReader(dbPath);
    const nodes = reader.countNodes(name);
    const edges = reader.countEdges(name);
    const stat = statSync(dbPath);
    reader.close();
    sendJson(res, 200, {
      name,
      status: 'healthy',
      nodes,
      edges,
      size_bytes: stat.size,
    });
  } catch (e: unknown) {
    ctx.log(`Project health check failed for name="${name}": ${errorMessage(e)}`);
    sendJson(res, 200, { name, status: 'corrupt', reason: 'Database health check failed' });
  }
}

/**
 * POST /api/project-delete — delete a project's code graph + human memory DBs.
 */
export async function routeProjectDelete(
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
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || name.startsWith('-')) {
    sendJson(res, 400, { error: 'Invalid project name (alphanumeric, dash, underscore only)' });
    return;
  }
  // Defense: refuse to delete the currently active project
  if (name === ctx.project) {
    sendJson(res, 400, { error: 'Cannot delete the currently active project. Stop the UI server first.' });
    return;
  }
  const dbPath = defaultCodeDbPath(name);
  const humanDbPath = defaultHumanDbPath(name);
  try {
    let deleted = false;
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
      deleted = true;
    }
    if (existsSync(humanDbPath)) {
      unlinkSync(humanDbPath);
      deleted = true;
    }
    // Also clean up WAL/SHM files
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
      if (existsSync(humanDbPath + suffix)) unlinkSync(humanDbPath + suffix);
    }
    ctx.log(`Project deleted: name="${name}" db=${dbPath}`);
    // R45 (F8): omit db_path from the response — defense-in-depth info leak.
    sendJson(res, 200, { success: true, name, deleted });
  } catch (e: unknown) {
    ctx.log(`Failed to delete project name="${name}": ${errorMessage(e)}`);
    sendJson(res, 500, { error: 'Failed to delete project' });
  }
}
