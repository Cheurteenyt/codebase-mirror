// v2/src/ui/server.ts
// V2 HTTP server for the graph UI.
// Replaces V1's C-based http_server.c with a clean Node.js implementation.
// Serves static assets + API endpoints that read from the V2 stores.
// R25: WebSocket server for real-time push notifications.
//
// R63: route handlers extracted to routes/*.ts (graph, project, human, index,
// system). This file is now a thin coordinator: constructor, start/stop,
// request handling, route table, WebSocket, static file serving.
// Shared types are in types.ts, shared helpers in helpers.ts.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { existsSync, readFileSync } from "node:fs";
import { resolve, extname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { HumanMemoryStore, defaultHumanDbPath } from '../human/store.js';
import { CodeGraphReader, defaultCodeDbPath } from '../bridge/sqlite-ro.js';
import { getNotifyHub } from './notify-hub.js';
import { DEFAULT_PORT, LOG_BUFFER_MAX, MIME_TYPES, errorMessage, sendJson } from './helpers.js';
import type { RouteContext, RouteHandler, IndexJob } from './types.js';
// Route handlers (R63: extracted to routes/*.ts)
import { routeLayout, routeDashboard, routeGraphStatus } from './routes/graph.js';
import { routeProjects, routeProjectHealth, routeProjectDelete } from './routes/project.js';
import { routeHumanNotes, routeAdrGet, routeAdrPost } from './routes/human.js';
import { routeIndex, routeIndexStatus } from './routes/index.js';
import { routeBrowse, routeProcesses, routeProcessKill, routeLogs } from './routes/system.js';

/**
 * R168.2: Resolve the graph-ui dist path from the module location, not
 * from process.cwd(). This allows the UI to be served when the package
 * is installed globally or run from Docker.
 *
 * Resolution order:
 * 1. dist/ui/ (embedded assets from Dockerfile / build script)
 * 2. ../graph-ui/dist/ (dev mode — running from v2/ in the repo)
 * 3. ../../graph-ui/dist/ (fallback for some layouts)
 */
function resolveGraphUiPath(): string {
  // Try embedded assets first (dist/ui/ relative to this compiled file)
  const moduleDir = resolve(fileURLToPath(import.meta.url), '..');
  const embedded = resolve(moduleDir, '..', 'ui');
  if (existsSync(resolve(embedded, 'index.html'))) {
    return embedded;
  }

  // Dev mode: look for graph-ui/dist relative to the repo root
  const devPath1 = resolve(process.cwd(), '..', 'graph-ui', 'dist');
  if (existsSync(resolve(devPath1, 'index.html'))) {
    return devPath1;
  }

  const devPath2 = resolve(moduleDir, '..', '..', '..', 'graph-ui', 'dist');
  if (existsSync(resolve(devPath2, 'index.html'))) {
    return devPath2;
  }

  // Fallback: return the embedded path even if it doesn't exist yet —
  // the server will return 404 for UI assets but API endpoints still work.
  return embedded;
}

export interface UiServerOptions {
  port?: number;
  project: string;
  graphUiPath?: string; // path to graph-ui/dist
}

export class UiServer {
  private server: ReturnType<typeof createServer>;
  private wss: WebSocketServer | null = null;
  private port: number;
  private project: string;
  private graphUiPath: string;
  private humanStore: HumanMemoryStore;
  private codeReader: CodeGraphReader | undefined;
  private indexJobs: Map<string, IndexJob> = new Map();
  private logBuffer: string[] = [];
  private wsClients: Set<WebSocket> = new Set();
  private hubUnsubscribe: (() => void) | null = null;
  // R61: track per-WebSocket project filter without augmenting the ws object.
  private wsProjectFilters: WeakMap<WebSocket, string | undefined> = new WeakMap();

  // R63: route table. Each entry delegates to a standalone route handler
  // in routes/*.ts, passing the RouteContext as the first argument.
  // The context provides humanStore, codeReader, project, port, graphUiPath,
  // indexJobs, logBuffer, log(), and sendJson() — everything routes need
  // without accessing the UiServer instance directly.
  private routes: Map<string, RouteHandler> = new Map([
    ['GET /api/layout',          (ctx, u, r, s, p) => routeLayout(ctx, u, r, s, p)],
    ['GET /api/projects',        (ctx, u, r, s, p) => routeProjects(ctx, u, r, s, p)],
    ['GET /api/project-health',  (ctx, u, r, s, p) => routeProjectHealth(ctx, u, r, s, p)],
    ['GET /api/dashboard',       (ctx, u, r, s, p) => routeDashboard(ctx, u, r, s, p)],
    ['GET /api/human-notes',     (ctx, u, r, s, p) => routeHumanNotes(ctx, u, r, s, p)],
    ['GET /api/graph-status',    (ctx, u, r, s, p) => routeGraphStatus(ctx, u, r, s, p)],
    ['GET /api/adr',             (ctx, u, r, s, p) => routeAdrGet(ctx, u, r, s, p)],
    ['POST /api/adr',            (ctx, u, r, s, p) => routeAdrPost(ctx, u, r, s, p)],
    ['GET /api/browse',          (ctx, u, r, s, p) => routeBrowse(ctx, u, r, s, p)],
    ['POST /api/index',          (ctx, u, r, s, p) => routeIndex(ctx, u, r, s, p)],
    ['GET /api/index-status',    (ctx, u, r, s, p) => routeIndexStatus(ctx, u, r, s, p)],
    ['GET /api/processes',       (ctx, u, r, s, p) => routeProcesses(ctx, u, r, s, p)],
    ['POST /api/process-kill',   (ctx, u, r, s, p) => routeProcessKill(ctx, u, r, s, p)],
    ['POST /api/project-delete', (ctx, u, r, s, p) => routeProjectDelete(ctx, u, r, s, p)],
    ['GET /api/logs',            (ctx, u, r, s, p) => routeLogs(ctx, u, r, s, p)],
  ]);

  constructor(opts: UiServerOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.project = opts.project;
    this.graphUiPath = opts.graphUiPath ?? resolveGraphUiPath();
    this.humanStore = new HumanMemoryStore(defaultHumanDbPath(this.project));
    this.humanStore.attachNotifyHub(getNotifyHub(), this.project);
    // Try to open the code graph reader. If the DB doesn't exist (project
    // not yet indexed), codeReader stays undefined — routes that need it
    // return 404 'Code graph not available'.
    // R80: Bug 12 fix — use defaultCodeDbPath (XDG_CACHE_HOME) instead of
    // relative `${project}.db` which opened DBs in the CWD.
    try {
      this.codeReader = new CodeGraphReader(defaultCodeDbPath(this.project));
    } catch {
      this.codeReader = undefined;
    }
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((e) => {
        process.stderr.write(`[cbm-v2 ui] unhandled error: ${e instanceof Error ? e.message : String(e)}\n`);
      });
    });
  }

  private log(line: string): void {
    this.logBuffer.push(`[${new Date().toISOString()}] ${line}`);
    if (this.logBuffer.length > LOG_BUFFER_MAX) {
      this.logBuffer.shift();
    }
  }

  /**
   * R63: build the RouteContext passed to every route handler. This is the
   * key abstraction that enables routes to live in separate files — they
   * receive their dependencies explicitly instead of accessing `this.*`.
   */
  private getRouteContext(): RouteContext {
    return {
      humanStore: this.humanStore,
      codeReader: this.codeReader,
      project: this.project,
      port: this.port,
      graphUiPath: this.graphUiPath,
      indexJobs: this.indexJobs,
      logBuffer: this.logBuffer,
      log: (line: string) => this.log(line),
      sendJson,
    };
  }

  start(): void {
    this.server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`Port ${this.port} is already in use. Use --port to specify a different port.`);
      } else {
        console.error('Server error:', e.message);
      }
      try {
        this.humanStore.close();
        this.codeReader?.close();
      } catch { /* ignore close errors during shutdown */ }
      process.exit(1);
    });
    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`[cbm-v2 ui] Graph UI server running at http://127.0.0.1:${this.port}`);
    });

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleWsConnection(ws, req);
    });

    this.hubUnsubscribe = getNotifyHub().subscribe((event) => {
      this.broadcastToWsClients(event);
    });
  }

  stop(): void {
    if (this.hubUnsubscribe) {
      this.hubUnsubscribe();
      this.hubUnsubscribe = null;
    }
    for (const ws of this.wsClients) {
      try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
    }
    this.wsClients.clear();
    this.wss?.close();
    this.server.close();
    this.humanStore.close();
    this.codeReader?.close();
  }

  private handleWsConnection(ws: WebSocket, _req: IncomingMessage): void {
    this.wsClients.add(ws);
    this.sendWsMessage(ws, {
      type: 'connected',
      project: this.project,
      timestamp: new Date().toISOString(),
    });
    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          this.sendWsMessage(ws, { type: 'pong', timestamp: new Date().toISOString() });
        }
        if (msg.type === 'subscribe' && typeof msg.project === 'string') {
          this.wsProjectFilters.set(ws, msg.project);
        }
      } catch {
        // ignore malformed messages
      }
    });
    ws.on('close', () => { this.wsClients.delete(ws); });
    ws.on('error', () => { this.wsClients.delete(ws); });
  }

  private broadcastToWsClients(event: { project: string; type: string; timestamp: string; data?: Record<string, unknown> }): void {
    const message = {
      type: 'notification',
      event: event.type,
      project: event.project,
      timestamp: event.timestamp,
      data: event.data,
    };
    const payload = JSON.stringify(message);
    for (const ws of this.wsClients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const filter = this.wsProjectFilters.get(ws);
      if (filter && filter !== event.project) continue;
      try {
        ws.send(payload);
      } catch {
        this.wsClients.delete(ws);
      }
    }
  }

  private sendWsMessage(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // ignore
      }
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const path = url.pathname;

    // CORS headers for vite dev server
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let responseSent = false;
    const markSent = () => { responseSent = true; };
    res.on('finish', markSent);
    res.on('close', markSent);

    try {
      if (path.startsWith('/api/')) {
        await this.handleApi(path, url, req, res);
        return;
      }
      if (path === '/' || path === '/index.html') {
        this.serveStatic('/index.html', res);
        return;
      }
      this.serveStatic(path, res);
    } catch (e: unknown) {
      if (responseSent || res.writableEnded) {
        process.stderr.write(`[cbm-v2 ui] post-response error: ${errorMessage(e)}\n`);
        return;
      }
      process.stderr.write(`[cbm-v2 ui] request failed: ${errorMessage(e)}\n`);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  /**
   * R41 (L1): route-table dispatcher. Looks up the handler by
   * `${method} ${path}` and calls it with the RouteContext.
   */
  private async handleApi(
    path: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const project = url.searchParams.get('project') ?? this.project;
    const handler = this.routes.get(`${req.method ?? 'GET'} ${path}`);
    if (!handler) {
      sendJson(res, 404, { error: `Unknown API endpoint: ${path}` });
      return;
    }
    await handler(this.getRouteContext(), url, req, res, project);
  }

  private serveStatic(path: string, res: ServerResponse): void {
    // R80: Bug 13 fix — resolve() ignores the base path when the second arg
    // starts with '/'. So resolve(base, '/index.html') returns '/index.html',
    // not base/index.html. Strip leading slashes first, then resolve.
    const normalized = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const root = resolve(this.graphUiPath);
    const filePath = resolve(root, normalized);
    // Defense-in-depth: verify the resolved path stays within the graphUiPath.
    const rel = relative(root, filePath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    if (!existsSync(filePath)) {
      sendJson(res, 404, { error: 'File not found' });
      return;
    }
    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
    const data = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  }
}
