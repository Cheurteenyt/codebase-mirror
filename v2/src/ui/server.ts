// V2 HTTP server for the graph UI.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_PORT, LOG_BUFFER_MAX, MIME_TYPES, errorMessage, sendJson } from './helpers.js';
import {
  ProjectStoreRegistry,
  isValidProjectName,
  pathsReferToSameStore,
  projectsReferToSameStores,
  type ProjectStores,
} from './project-store-registry.js';
import { defaultCodeDbPath } from '../bridge/sqlite-ro.js';
import { getNotifyHub } from './notify-hub.js';
import type { IndexJob, RouteContext, RouteHandler } from './types.js';
import {
  routeDashboard,
  routeGraphStatus,
  routeLayout,
  routeNeighborhood,
  routeNodeSearch,
  routePath,
  routeScope,
} from './routes/graph.js';
import { routeProjectDelete, routeProjectHealth, routeProjects } from './routes/project.js';
import { routeAdrGet, routeAdrPost, routeHumanNotes } from './routes/human.js';
import {
  forceIndexJobTermination,
  isActiveIndexJob,
  requestIndexJobTermination,
  routeIndex,
  routeIndexJobTerminate,
  routeIndexStatus,
} from './routes/index.js';
import { routeBrowse, routeLogs, routeProcesses } from './routes/system.js';

const DEFAULT_INDEX_JOB_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_INDEX_JOB_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_MAX_CONCURRENT_INDEX_JOBS = 2;
const DEFAULT_MAX_CONCURRENT_INDEX_JOBS_PER_PROJECT = 1;
// Four hot projects keep the theoretical SQLite page-cache ceiling bounded
// (4 x (64 MiB code + 8 MiB human)) while preserving instant tab switching.
const DEFAULT_PROJECT_STORE_LIMIT = 4;
const DEFAULT_TRANSPORT_SHUTDOWN_GRACE_MS = 1_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const FORCED_TRANSPORT_SETTLE_RESERVE_MS = 100;
const WS_MAX_PAYLOAD_BYTES = 64 * 1024;
const WS_RATE_WINDOW_MS = 10_000;
const WS_RATE_MAX_MESSAGES = 60;

function resolveGraphUiPath(): string {
  const moduleDir = resolve(fileURLToPath(import.meta.url), '..');
  const embedded = resolve(moduleDir, '..', 'ui');
  if (existsSync(resolve(embedded, 'index.html'))) return embedded;

  const devPath1 = resolve(process.cwd(), '..', 'graph-ui', 'dist');
  if (existsSync(resolve(devPath1, 'index.html'))) return devPath1;

  const devPath2 = resolve(moduleDir, '..', '..', '..', 'graph-ui', 'dist');
  if (existsSync(resolve(devPath2, 'index.html'))) return devPath2;
  return embedded;
}

function settleUntil(promise: Promise<unknown>, deadline: number): Promise<boolean> {
  const remainingMs = Math.max(0, deadline - Date.now());
  if (remainingMs === 0) return Promise.resolve(false);

  return new Promise((resolveSettled) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSettled(value);
    };
    const timer = setTimeout(() => finish(false), remainingMs);
    void promise.then(() => finish(true), () => finish(true));
  });
}

export interface UiServerOptions {
  port?: number;
  project: string;
  graphUiPath?: string;
  /** Explicit development proxy origin, e.g. http://localhost:5173. */
  devOrigin?: string;
  projectStoreLimit?: number;
  /** Additional repository roots the local Control UI may browse/index. */
  allowedRoots?: string[];
  indexJobTimeoutMs?: number;
  indexJobTerminationGraceMs?: number;
  /** Grace period for cooperative WebSocket and HTTP connection draining. */
  transportShutdownGraceMs?: number;
  /** Hard deadline covering transport and owned-indexer shutdown together. */
  shutdownTimeoutMs?: number;
  maxConcurrentIndexJobs?: number;
  maxConcurrentIndexJobsPerProject?: number;
  getIndexerLaunch?: (rootPath: string, project: string) => { command: string; args: string[] };
}

interface WsRateState {
  windowStartedAt: number;
  messages: number;
}

export class UiServer {
  private readonly server: ReturnType<typeof createServer>;
  private wss: WebSocketServer | null = null;
  private readonly port: number;
  private readonly project: string;
  private readonly graphUiPath: string;
  private readonly registry: ProjectStoreRegistry;
  private readonly csrfToken = randomBytes(32).toString('base64url');
  private readonly devOrigin: string | undefined;
  private readonly indexJobTimeoutMs: number;
  private readonly indexJobTerminationGraceMs: number;
  private readonly transportShutdownGraceMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly maxConcurrentIndexJobs: number;
  private readonly maxConcurrentIndexJobsPerProject: number;
  private readonly getIndexerLaunch: (rootPath: string, project: string) => { command: string; args: string[] };
  private readonly configuredAllowedRoots: string[];
  private readonly indexJobs = new Map<string, IndexJob>();
  private readonly logBuffer: string[] = [];
  private readonly wsClients = new Set<WebSocket>();
  private readonly httpSockets = new Set<Socket>();
  private readonly wsProjectFilters = new WeakMap<WebSocket, string | undefined>();
  private readonly wsRateStates = new WeakMap<WebSocket, WsRateState>();
  private hubUnsubscribe: (() => void) | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;

  private readonly routes: Map<string, RouteHandler> = new Map([
    ['GET /api/layout',          (ctx, u, r, s, p) => routeLayout(ctx, u, r, s, p)],
    ['GET /api/neighborhood',    (ctx, u, r, s, p) => routeNeighborhood(ctx, u, r, s, p)],
    ['GET /api/node-search',     (ctx, u, r, s, p) => routeNodeSearch(ctx, u, r, s, p)],
    ['GET /api/path',            (ctx, u, r, s, p) => routePath(ctx, u, r, s, p)],
    ['GET /api/scope',           (ctx, u, r, s, p) => routeScope(ctx, u, r, s, p)],
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
    ['POST /api/project-delete', (ctx, u, r, s, p) => routeProjectDelete(ctx, u, r, s, p)],
    ['GET /api/logs',            (ctx, u, r, s, p) => routeLogs(ctx, u, r, s, p)],
  ]);

  constructor(opts: UiServerOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.project = opts.project;
    this.graphUiPath = opts.graphUiPath ?? resolveGraphUiPath();
    this.devOrigin = opts.devOrigin ? new URL(opts.devOrigin).origin : undefined;
    this.indexJobTimeoutMs = opts.indexJobTimeoutMs ?? DEFAULT_INDEX_JOB_TIMEOUT_MS;
    this.indexJobTerminationGraceMs = opts.indexJobTerminationGraceMs ?? DEFAULT_INDEX_JOB_TERMINATION_GRACE_MS;
    this.transportShutdownGraceMs = opts.transportShutdownGraceMs ?? DEFAULT_TRANSPORT_SHUTDOWN_GRACE_MS;
    this.shutdownTimeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.maxConcurrentIndexJobs = opts.maxConcurrentIndexJobs ?? DEFAULT_MAX_CONCURRENT_INDEX_JOBS;
    this.maxConcurrentIndexJobsPerProject = opts.maxConcurrentIndexJobsPerProject
      ?? DEFAULT_MAX_CONCURRENT_INDEX_JOBS_PER_PROJECT;
    this.getIndexerLaunch = opts.getIndexerLaunch ?? this.createNativeIndexerLaunch();
    this.configuredAllowedRoots = [homedir(), ...(opts.allowedRoots ?? [])].map((root) => resolve(root));
    this.registry = new ProjectStoreRegistry(
      this.project,
      opts.projectStoreLimit ?? DEFAULT_PROJECT_STORE_LIMIT,
    );
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((error: unknown) => {
        process.stderr.write(`[cbm-v2 ui] unhandled error: ${errorMessage(error)}\n`);
        if (!res.writableEnded) sendJson(res, 500, { error: 'Internal server error' });
      });
    });
    this.server.on('connection', (socket) => {
      this.httpSockets.add(socket);
      socket.once('close', () => this.httpSockets.delete(socket));
    });
  }

  async start(): Promise<void> {
    try {
      await new Promise<void>((resolveStart, rejectStart) => {
        const onError = (error: Error) => rejectStart(error);
        this.server.once('error', onError);
        this.server.listen(this.port, '127.0.0.1', () => {
          this.server.off('error', onError);
          resolveStart();
        });
      });
    } catch (error: unknown) {
      await this.stop();
      const cause = error as NodeJS.ErrnoException;
      if (cause.code === 'EADDRINUSE') {
        throw new Error(`Port ${this.port} is already in use. Use --port to specify a different port.`, {
          cause,
        });
      }
      throw error;
    }

    // stop() may have completed while listen() was still resolving. Do not
    // install a WebSocket server or notification subscription after that
    // shutdown barrier; close the newly-bound HTTP listener explicitly.
    if (this.stopping) {
      await new Promise<void>((resolveClose) => {
        try { this.server.close(() => resolveClose()); }
        catch { resolveClose(); }
      });
      throw new Error('UI server was stopped while starting');
    }

    console.log(`[cbm-v2 ui] Graph UI server running at http://127.0.0.1:${this.port}`);
    this.server.on('error', (error: NodeJS.ErrnoException) => {
      console.error('Server error:', error.message);
      void this.stop();
    });

    this.wss = new WebSocketServer({
      server: this.server,
      maxPayload: WS_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
      verifyClient: ({ req }: { req: IncomingMessage }) => this.isAllowedWebSocketUpgrade(req),
    });
    this.wss.on('connection', (ws, req) => this.handleWsConnection(ws, req));

    this.hubUnsubscribe = getNotifyHub().subscribe((event) => {
      this.broadcastToWsClients(event);
    });
  }

  /**
   * Idempotent bounded shutdown: stop accepting traffic, terminate owned
   * indexers, escalate after the grace period, then close every SQLite handle.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    // Set this synchronously so an in-flight request suspended while reading
    // its body cannot launch a new child before stopInternal takes a snapshot.
    this.stopping = true;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    const deadline = Date.now() + Math.max(0, this.shutdownTimeoutMs);
    this.hubUnsubscribe?.();
    this.hubUnsubscribe = null;

    // Start every independently blocking part before waiting. This keeps the
    // hard deadline global instead of accidentally granting one full timeout
    // to WebSockets, another to HTTP, and another to owned indexers.
    const webSocketClosed = this.beginWebSocketClose();
    const httpClosed = this.beginHttpClose();
    for (const ws of this.wsClients) {
      try { ws.close(1001, 'server shutting down'); } catch { /* best effort */ }
    }
    const ownedIndexersTerminated = this.terminateOwnedIndexJobsForShutdown(deadline);

    const remainingTransportBudget = Math.max(0, deadline - Date.now());
    // Reserve part of a very short global budget for the close callbacks that
    // ws and node:http emit immediately after terminate()/destroy(). Without
    // this reserve, a grace period clipped exactly to the hard deadline would
    // leave no time to await the closures we just forced.
    const forcedCloseReserveMs = Math.min(
      FORCED_TRANSPORT_SETTLE_RESERVE_MS,
      Math.floor(remainingTransportBudget / 2),
    );
    const transportGraceDeadline = Math.min(
      deadline - forcedCloseReserveMs,
      Date.now() + Math.max(0, this.transportShutdownGraceMs),
    );
    await settleUntil(Promise.all([webSocketClosed, httpClosed]), transportGraceDeadline);

    // A WebSocket peer is allowed a graceful close handshake first. After the
    // grace period, terminate it and destroy every HTTP socket still owned by
    // this server. Node's closeAllConnections() intentionally skips upgraded
    // sockets, so explicit socket tracking is required for a complete bound.
    this.forceCloseTransports();
    await settleUntil(
      Promise.all([webSocketClosed, httpClosed, ownedIndexersTerminated]),
      deadline,
    );

    // Defense in depth: HTTP draining is the synchronization barrier after
    // which no route can still create a child. Sweep again so even an unusual
    // in-flight route or injected launcher cannot escape process ownership.
    await this.terminateOwnedIndexJobsForShutdown(deadline);
    this.forceCloseTransports();
    this.wsClients.clear();
    this.httpSockets.clear();
    this.wss = null;
    this.registry.closeAll();
  }

  private beginWebSocketClose(): Promise<void> {
    const wss = this.wss;
    if (!wss) return Promise.resolve();
    return new Promise((resolveClose) => {
      try {
        wss.close(() => resolveClose());
      } catch {
        resolveClose();
      }
    });
  }

  private beginHttpClose(): Promise<void> {
    return new Promise((resolveClose) => {
      if (!this.server.listening) {
        resolveClose();
        return;
      }
      try {
        this.server.close(() => resolveClose());
        this.server.closeIdleConnections();
      } catch {
        resolveClose();
      }
    });
  }

  private forceCloseTransports(): void {
    const clients = new Set<WebSocket>([
      ...this.wsClients,
      ...(this.wss?.clients ?? []),
    ]);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.CLOSED) continue;
      try { ws.terminate(); } catch { /* best effort */ }
    }
    try { this.server.closeAllConnections(); } catch { /* best effort */ }
    for (const socket of this.httpSockets) {
      try { socket.destroy(); } catch { /* best effort */ }
    }
  }

  private async terminateOwnedIndexJobsForShutdown(deadline: number): Promise<void> {
    const activeJobs = [...this.indexJobs.values()].filter((job) => isActiveIndexJob(job) && job.child);
    if (activeJobs.length === 0) return;

    const childSettled = Promise.all(activeJobs.map((job) => new Promise<void>((resolveChild) => {
      const child = job.child;
      if (!child) {
        resolveChild();
        return;
      }
      child.once('close', () => resolveChild());
      child.once('error', () => resolveChild());
    })));
    for (const job of activeJobs) {
      requestIndexJobTermination(this.getRouteContextForShutdown(), job, 'shutdown');
    }

    const initialTreeSettled = Promise.all(
      activeJobs.map((job) => job.treeKillPromise ?? Promise.resolve()),
    );
    await settleUntil(
      Promise.all([childSettled, initialTreeSettled]),
      Math.min(deadline, Date.now() + Math.max(0, this.indexJobTerminationGraceMs)),
    );
    for (const job of activeJobs) {
      if (!job.child || !isActiveIndexJob(job)) continue;
      forceIndexJobTermination(this.getRouteContextForShutdown(), job);
    }
    const forcedTreeSettled = Promise.all(
      activeJobs.map((job) => job.treeKillPromise ?? Promise.resolve()),
    );
    await settleUntil(
      Promise.all([childSettled, forcedTreeSettled]),
      // taskkill /T can take more than 250 ms on a busy Windows runner. It is
      // already bounded by both its own timeout and the single shutdown
      // deadline, so let it use the remaining global budget instead of
      // killing the tree-killer early and orphaning descendants.
      deadline,
    );

    for (const job of activeJobs) {
      if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
      if (job.forceKillTimer) clearTimeout(job.forceKillTimer);
      if (job.treeKillTimeout) clearTimeout(job.treeKillTimeout);
      if (job.treeKiller?.exitCode === null) {
        try { job.treeKiller.kill('SIGKILL'); } catch { /* best effort */ }
      }
      job.timeoutTimer = undefined;
      job.forceKillTimer = undefined;
      job.treeKillTimeout = undefined;
      job.treeKiller = undefined;
      if (job.child && isActiveIndexJob(job)) {
        job.status = 'cancelled';
        job.error = 'UI server shut down before the indexer confirmed exit';
        job.child = undefined;
      }
    }

  }

  private log(line: string): void {
    this.logBuffer.push(`[${new Date().toISOString()}] ${line}`);
    if (this.logBuffer.length > LOG_BUFFER_MAX) this.logBuffer.shift();
  }

  private getRouteContext(stores: ProjectStores, project: string): RouteContext {
    return {
      get humanStore() { return stores.humanStore; },
      get codeReader() { return stores.codeReader; },
      project,
      port: this.port,
      graphUiPath: this.graphUiPath,
      indexJobs: this.indexJobs,
      refreshCodeReader: (name) => this.registry.refreshCodeReader(name),
      resolveProjectName: (name) => {
        const resolved = this.registry.resolveProjectName(name);
        for (const job of this.indexJobs.values()) {
          if (!isActiveIndexJob(job)) continue;
          if (projectsReferToSameStores(name, job.project)) return job.project;
        }
        return resolved;
      },
      isProjectStoreOpen: (name) => this.registry.isProjectStoreOpen(name)
        || [...this.indexJobs.values()].some((job) => isActiveIndexJob(job)
          && pathsReferToSameStore(defaultCodeDbPath(name), defaultCodeDbPath(job.project))),
      getAllowedRoots: () => {
        const roots = [...this.configuredAllowedRoots];
        try {
          const indexedRoot = stores.codeReader?.getProjectRoot(project);
          if (indexedRoot) roots.push(indexedRoot);
        } catch {
          // A missing/legacy graph simply contributes no dynamic root.
        }
        return [...new Set(roots)];
      },
      indexJobTimeoutMs: this.indexJobTimeoutMs,
      indexJobTerminationGraceMs: this.indexJobTerminationGraceMs,
      maxConcurrentIndexJobs: this.maxConcurrentIndexJobs,
      maxConcurrentIndexJobsPerProject: this.maxConcurrentIndexJobsPerProject,
      isStopping: () => this.stopping,
      getIndexerLaunch: this.getIndexerLaunch,
      logBuffer: this.logBuffer,
      log: (line) => this.log(line),
      sendJson,
    };
  }

  private getRouteContextForShutdown(): RouteContext {
    const lease = this.registry.acquire(this.project);
    const context = this.getRouteContext(lease.stores, this.project);
    lease.release();
    return context;
  }

  private createNativeIndexerLaunch(): (
    rootPath: string,
    project: string,
  ) => { command: string; args: string[] } {
    const compiledCli = fileURLToPath(new URL('../cli/index.js', import.meta.url));
    const sourceCli = fileURLToPath(new URL('../cli/index.ts', import.meta.url));
    const tsxCli = resolve(dirname(sourceCli), '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    return (rootPath, project) => {
      const commandArgs = ['index', '--project', project, '--root', rootPath, '--incremental'];
      if (existsSync(compiledCli)) {
        return { command: process.execPath, args: [compiledCli, ...commandArgs] };
      }
      if (existsSync(sourceCli)) {
        if (existsSync(tsxCli)) {
          return { command: process.execPath, args: [tsxCli, sourceCli, ...commandArgs] };
        }
        return { command: process.execPath, args: [...process.execArgv, sourceCli, ...commandArgs] };
      }
      return {
        command: process.platform === 'win32' ? 'cbm-v2.cmd' : 'cbm-v2',
        args: commandArgs,
      };
    };
  }

  private applySecurityHeaders(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; `
      + `script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; `
      + `font-src 'self'; connect-src 'self' ws://127.0.0.1:${this.port} ws://localhost:${this.port}`,
    );
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    const origin = req.headers.origin;
    if (this.devOrigin && origin === this.devOrigin) {
      res.setHeader('Access-Control-Allow-Origin', this.devOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CBM-CSRF');
    }
  }

  private isAllowedHost(host: string | undefined): boolean {
    if (!host) return false;
    const normalized = host.toLocaleLowerCase('en-US');
    const allowed = new Set([
      `127.0.0.1:${this.port}`,
      `localhost:${this.port}`,
    ]);
    if (this.devOrigin) allowed.add(new URL(this.devOrigin).host.toLocaleLowerCase('en-US'));
    return allowed.has(normalized);
  }

  private isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
    if (!origin) return true;
    if (!host) return false;
    try {
      const parsed = new URL(origin);
      if (parsed.origin === `http://${host.toLocaleLowerCase('en-US')}`) return true;
      return this.devOrigin !== undefined && parsed.origin === this.devOrigin;
    } catch {
      return false;
    }
  }

  private tokenMatches(candidate: string | string[] | undefined): boolean {
    if (typeof candidate !== 'string') return false;
    const expectedBuffer = Buffer.from(this.csrfToken, 'utf8');
    const candidateBuffer = Buffer.from(candidate, 'utf8');
    return candidateBuffer.length === expectedBuffer.length
      && timingSafeEqual(candidateBuffer, expectedBuffer);
  }

  private validateMutation(req: IncomingMessage): string | null {
    const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US');
    if (contentType !== 'application/json') return 'Mutations require Content-Type: application/json';

    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return 'Mutations require Sec-Fetch-Site: same-origin or none';
    }
    if (!req.headers.origin && fetchSite !== 'none') return 'Mutation Origin is required';
    if (!this.tokenMatches(req.headers['x-cbm-csrf'])) return 'Invalid CSRF token';
    return null;
  }

  private isAllowedWebSocketUpgrade(req: IncomingMessage): boolean {
    if (!this.isAllowedHost(req.headers.host)) return false;
    if (!req.headers.origin || !this.isAllowedOrigin(req.headers.origin, req.headers.host)) return false;
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return false;
    }
    return url.pathname === '/ws' && this.tokenMatches(url.searchParams.get('csrf') ?? undefined);
  }

  private handleWsConnection(ws: WebSocket, _req: IncomingMessage): void {
    this.wsClients.add(ws);
    this.wsRateStates.set(ws, { windowStartedAt: Date.now(), messages: 0 });
    this.sendWsMessage(ws, {
      type: 'connected',
      project: this.project,
      timestamp: new Date().toISOString(),
    });
    ws.on('message', (data) => {
      const now = Date.now();
      const rate = this.wsRateStates.get(ws) ?? { windowStartedAt: now, messages: 0 };
      if (now - rate.windowStartedAt >= WS_RATE_WINDOW_MS) {
        rate.windowStartedAt = now;
        rate.messages = 0;
      }
      rate.messages += 1;
      this.wsRateStates.set(ws, rate);
      if (rate.messages > WS_RATE_MAX_MESSAGES) {
        ws.close(1008, 'message rate exceeded');
        return;
      }

      try {
        const msg = JSON.parse(data.toString()) as { type?: unknown; project?: unknown };
        if (msg.type === 'ping') {
          this.sendWsMessage(ws, { type: 'pong', timestamp: new Date().toISOString() });
          return;
        }
        if (msg.type === 'subscribe' && typeof msg.project === 'string' && isValidProjectName(msg.project)) {
          this.wsProjectFilters.set(ws, this.registry.resolveProjectName(msg.project));
          return;
        }
        ws.close(1008, 'invalid message');
      } catch {
        ws.close(1007, 'invalid JSON');
      }
    });
    ws.on('close', () => this.wsClients.delete(ws));
    ws.on('error', () => this.wsClients.delete(ws));
  }

  private broadcastToWsClients(event: {
    project: string;
    type: string;
    timestamp: string;
    data?: Record<string, unknown>;
  }): void {
    const payload = JSON.stringify({
      type: 'notification',
      event: event.type,
      project: event.project,
      timestamp: event.timestamp,
      data: event.data,
    });
    for (const ws of this.wsClients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const filter = this.wsProjectFilters.get(ws);
      if (filter && filter !== event.project) continue;
      try { ws.send(payload); } catch { this.wsClients.delete(ws); }
    }
  }

  private sendWsMessage(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(message)); } catch { /* best effort */ }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.applySecurityHeaders(req, res);
    if (!this.isAllowedHost(req.headers.host)) {
      sendJson(res, 403, { error: 'Invalid Host header' });
      return;
    }
    // Browser-initiated cross-site GETs (for example, an <img> pointed at a
    // localhost API) commonly omit Origin but carry Fetch Metadata. Reject
    // them before routing so read endpoints cannot create lazy local state.
    const isExplicitDevRequest = this.devOrigin !== undefined
      && req.headers.origin === this.devOrigin;
    if (req.headers['sec-fetch-site'] === 'cross-site' && !isExplicitDevRequest) {
      sendJson(res, 403, { error: 'Cross-site requests are not allowed' });
      return;
    }
    if (!this.isAllowedOrigin(req.headers.origin, req.headers.host)) {
      sendJson(res, 403, { error: 'Origin is not allowed' });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'POST') {
      const mutationError = this.validateMutation(req);
      if (mutationError) {
        sendJson(res, 403, { error: mutationError });
        return;
      }
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const path = url.pathname;
    let responseSent = false;
    const markSent = () => { responseSent = true; };
    res.on('finish', markSent);
    res.on('close', markSent);

    try {
      if (path.startsWith('/api/')) {
        await this.handleApi(path, url, req, res);
      } else if (path === '/' || path === '/index.html') {
        this.serveStatic('/index.html', res);
      } else {
        this.serveStatic(path, res);
      }
    } catch (error: unknown) {
      if (responseSent || res.writableEnded) {
        process.stderr.write(`[cbm-v2 ui] post-response error: ${errorMessage(error)}\n`);
        return;
      }
      process.stderr.write(`[cbm-v2 ui] request failed: ${errorMessage(error)}\n`);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  private async handleApi(
    path: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (path === '/api/bootstrap' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      sendJson(res, 200, { csrf_token: this.csrfToken });
      return;
    }

    const dynamicTerminate = req.method === 'POST'
      && /^\/api\/index-jobs\/[^/]+\/terminate$/.test(path);
    const handler = dynamicTerminate
      ? routeIndexJobTerminate
      : this.routes.get(`${req.method ?? 'GET'} ${path}`);
    if (!handler) {
      sendJson(res, 404, { error: `Unknown API endpoint: ${path}` });
      return;
    }

    const project = url.searchParams.get('project') ?? this.project;
    if (!isValidProjectName(project)) {
      sendJson(res, 400, { error: 'Invalid project name' });
      return;
    }

    const lease = this.registry.acquire(project);
    try {
      const routedProject = lease.stores.project;
      const ctx = this.getRouteContext(lease.stores, routedProject);
      await handler(ctx, url, req, res, routedProject);
    } finally {
      lease.release();
    }
  }

  private serveStatic(path: string, res: ServerResponse): void {
    const normalized = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    const root = resolve(this.graphUiPath);
    const filePath = resolve(root, normalized);
    const rel = relative(root, filePath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      sendJson(res, 403, { error: 'Forbidden' });
      return;
    }
    if (!existsSync(filePath)) {
      sendJson(res, 404, { error: 'File not found' });
      return;
    }
    const mime = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
    const content = readFileSync(filePath);
    // Vite fingerprints production assets. Let the browser reuse those bytes
    // indefinitely, while forcing index.html and any unversioned file to
    // revalidate so an installed update can point at its new asset names.
    const immutableAsset = /^assets\/.+-[A-Za-z0-9_-]{6,}\.[^/]+$/u.test(normalized);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': content.byteLength,
      'Cache-Control': immutableAsset
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    res.end(content);
  }
}
