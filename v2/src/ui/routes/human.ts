// v2/src/ui/routes/human.ts
// R63: human memory routes — notes listing, ADR CRUD.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, errorMessage, parseJsonBody } from '../helpers.js';
import { isValidProjectName } from '../project-store-registry.js';
import type { RouteContext } from '../types.js';

/**
 * GET /api/human-notes — V2 human notes for a code node (or all notes).
 */
export async function routeHumanNotes(
  ctx: RouteContext,
  url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  project: string,
): Promise<void> {
  const cbmNodeId = url.searchParams.get('cbm_node_id');
  let notes;
  if (cbmNodeId) {
    const n = parseInt(cbmNodeId, 10);
    // R51 (SEC-13): reject negative cbm_node_id.
    if (!Number.isFinite(n) || n <= 0) {
      sendJson(res, 400, { error: "invalid cbm_node_id" });
      return;
    }
    notes = ctx.humanStore.listNodesByCbmNodeId(project, n);
  } else {
    notes = ctx.humanStore.listNodes(project, { limit: 100 });
  }
  sendJson(res, 200, {
    notes: notes.map((n) => ({
      id: n.id,
      label: n.label,
      title: n.title,
      status: n.status,
      body_excerpt: (n.body_markdown ?? "").slice(0, 200),
      obsidian_path: n.obsidian_path,
      updated_at: n.updated_at,
    })),
  });
}

/**
 * GET /api/adr — list all ADR notes for the project.
 */
export async function routeAdrGet(
  ctx: RouteContext,
  _url: URL,
  _req: IncomingMessage,
  res: ServerResponse,
  project: string,
): Promise<void> {
  const adrs = ctx.humanStore.listNodes(project, { label: 'ADR', limit: 500 });
  if (adrs.length === 0) {
    sendJson(res, 200, { has_adr: false });
    return;
  }
  const latest = adrs[0];
  sendJson(res, 200, {
    has_adr: true,
    content: latest.body_markdown,
    updated_at: latest.updated_at,
    title: latest.title,
    slug: latest.slug,
    obsidian_path: latest.obsidian_path,
    all_adrs: adrs.map((a) => ({
      id: a.id,
      title: a.title,
      slug: a.slug,
      status: a.status,
      updated_at: a.updated_at,
      obsidian_path: a.obsidian_path,
    })),
  });
}

/**
 * POST /api/adr — create or update an ADR note.
 * R51 (SEC-6): validates body.project if provided to prevent IDOR.
 */
export async function routeAdrPost(
  ctx: RouteContext,
  _url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  project: string,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }
  const content = typeof body.content === 'string' ? body.content : '';
  const title = typeof body.title === 'string' ? body.title : `ADR-${Date.now().toString(36)}`;
  let adrProject = project;
  if (typeof body.project === 'string') {
    if (!isValidProjectName(body.project)) {
      sendJson(res, 400, { error: 'Invalid project name in body' });
      return;
    }
    if (ctx.resolveProjectName(body.project) !== project) {
      sendJson(res, 409, { error: 'Body project must match the routed project' });
      return;
    }
    adrProject = project;
  }
  try {
    const existing = ctx.humanStore.listNodes(adrProject, { label: 'ADR', limit: 500 })
      .find((a) => a.title === title);
    let node;
    if (existing) {
      node = ctx.humanStore.updateNode(existing.id, { body_markdown: content });
    } else {
      node = ctx.humanStore.createNode({
        project: adrProject,
        label: 'ADR',
        title,
        body_markdown: content,
        source: 'human',
        status: 'active',
        tags: ['adr'],
      });
    }
    ctx.log(`ADR saved: id=${node!.id} title="${title}"`);
    sendJson(res, 200, {
      success: true,
      id: node!.id,
      title: node!.title,
      slug: node!.slug,
      obsidian_path: node!.obsidian_path,
      updated_at: node!.updated_at,
    });
  } catch (e: unknown) {
    ctx.log(`ADR save failed: ${errorMessage(e)}`);
    sendJson(res, 500, { error: 'Failed to save ADR' });
  }
}
