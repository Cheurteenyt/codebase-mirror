// v2/src/ui/routes/project.ts
// R63: project management routes — list, health, delete.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  existsSync,
  lstatSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CodeGraphReader, defaultCodeDbPath } from '../../bridge/sqlite-ro.js';
import { defaultHumanDbPath } from '../../human/store.js';
import { sendJson, errorMessage, parseJsonBody } from '../helpers.js';
import { isValidProjectName } from '../project-store-registry.js';
import type { RouteContext } from '../types.js';

interface ProjectDeletionResult {
  deleted: boolean;
  cleanupPending: boolean;
}

/**
 * Move every SQLite file out of the live namespace before deleting any byte.
 * If Windows rejects a rename because another process owns a handle, all
 * earlier moves are rolled back, avoiding a half-deleted code/human pair.
 */
function deleteProjectStores(codeDbPath: string, humanDbPath: string): ProjectDeletionResult {
  const candidates = [codeDbPath, humanDbPath]
    .flatMap((path) => [path, `${path}-wal`, `${path}-shm`]);
  const existing = candidates.filter((path) => existsSync(path));

  // Validate the complete set before the first rename. Never remove a
  // directory or another unexpected filesystem object through this endpoint.
  for (const path of existing) {
    const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error('Project storage contains a non-file entry');
    }
  }
  if (existing.length === 0) return { deleted: false, cleanupPending: false };

  const token = randomUUID();
  const staged: Array<{ source: string; tombstone: string }> = [];
  try {
    for (const [index, source] of existing.entries()) {
      const tombstone = `${source}.cbm-delete-${token}-${index}`;
      renameSync(source, tombstone);
      staged.push({ source, tombstone });
    }
  } catch (stageError: unknown) {
    const rollbackErrors: unknown[] = [];
    for (const entry of staged.reverse()) {
      try {
        if (!existsSync(entry.tombstone)) continue;
        if (existsSync(entry.source)) {
          throw new Error('Deletion rollback destination was recreated');
        }
        renameSync(entry.tombstone, entry.source);
      } catch (rollbackError: unknown) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([stageError, ...rollbackErrors], 'Project deletion staging and rollback failed');
    }
    throw stageError;
  }

  // The deletion is committed once all live names are staged. Cleanup is
  // best-effort: an antivirus may briefly hold a tombstone on Windows, but it
  // can no longer be mistaken for a usable project database.
  let cleanupPending = false;
  for (const { tombstone } of staged) {
    try {
      unlinkSync(tombstone);
    } catch {
      cleanupPending = true;
    }
  }
  return { deleted: true, cleanupPending };
}

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
      if (f.endsWith('.db') && !f.endsWith('.human.db') && f.toLowerCase() !== '_config.db') {
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
 * R45 (F6/SEC4): validates the cross-platform storage name to prevent path traversal.
 */
export async function routeProjectHealth(
  ctx: RouteContext,
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  project: string,
): Promise<void> {
  const name = url.searchParams.get('name') ?? project;
  if (!isValidProjectName(name)) {
    sendJson(res, 400, { error: 'Invalid project name for cross-platform storage' });
    return;
  }
  const dbPath = defaultCodeDbPath(name);
  if (!existsSync(dbPath)) {
    sendJson(res, 200, { name, status: 'missing', reason: 'DB file not found' });
    return;
  }
  let reader: CodeGraphReader | undefined;
  try {
    reader = new CodeGraphReader(dbPath);
    const nodes = reader.countNodes(name);
    const edges = reader.countEdges(name);
    const stat = statSync(dbPath);
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
  } finally {
    reader?.close();
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
  if (!isValidProjectName(name)) {
    sendJson(res, 400, { error: 'Invalid project name for cross-platform storage' });
    return;
  }
  // Refuse deletion when either DB path resolves to a store currently owned
  // by this server. This uses canonical path / file identity, not a
  // case-sensitive logical project-name comparison.
  if (ctx.isProjectStoreOpen(name)) {
    sendJson(res, 409, { error: 'Cannot delete a project with an open store. Stop the UI server or close the project first.' });
    return;
  }
  const dbPath = defaultCodeDbPath(name);
  const humanDbPath = defaultHumanDbPath(name);
  try {
    const { deleted, cleanupPending } = deleteProjectStores(dbPath, humanDbPath);
    ctx.log(`Project deleted: name="${name}" db=${dbPath}`);
    if (cleanupPending) {
      ctx.log(`Project deletion cleanup pending: name="${name}"`);
    }
    // R45 (F8): omit db_path from the response — defense-in-depth info leak.
    sendJson(res, 200, { success: true, name, deleted, cleanup_pending: cleanupPending });
  } catch (e: unknown) {
    ctx.log(`Failed to delete project name="${name}": ${errorMessage(e)}`);
    sendJson(res, 500, { error: 'Failed to delete project' });
  }
}
