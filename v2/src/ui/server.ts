// v2/src/ui/server.ts
// V2 HTTP server for the graph UI.
// Replaces V1's C-based http_server.c with a clean Node.js implementation.
// Serves static assets + API endpoints that read from the V2 stores.
// R25: WebSocket server for real-time push notifications.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
// R41 (L3): replaced 4 dynamic `await import('node:fs'/'node:child_process')`
// with static imports. Dynamic imports of built-in modules hit the require
// cache but still resolve a Promise per call (~50-100µs overhead). The line
// `const { readdirSync } = await import('node:fs')` at line 399 was also pure
// dead code — it shadowed the top-level static import.
import { existsSync, readFileSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { join, extname, resolve, sep, dirname } from "node:path";
import { homedir } from 'node:os';
import { HumanMemoryStore, defaultHumanDbPath } from '../human/store.js';
import { CodeGraphReader, defaultCodeDbPath } from '../bridge/sqlite-ro.js';
import { getGraphStatus, getFreshnessScore, freshnessLabel } from '../intelligence/graph-status.js';
import { computeRiskScore } from '../reports/risk.js';
import { safeJsonParse, MAX_NODES_PER_LABEL } from '../constants.js';
import { getNotifyHub } from './notify-hub.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mjs': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const DEFAULT_PORT = 9749;

export interface UiServerOptions {
  port?: number;
  project: string;
  graphUiPath?: string; // path to graph-ui/dist
}

// R41 (L1): route-table dispatcher type. Each /api/* endpoint is a
// RouteHandler that receives the parsed URL, the request, the response,
// and the resolved project name. Routes that don't use `project` (e.g.
// /api/projects lists all projects) simply ignore the parameter.
type RouteHandler = (
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  project: string,
) => Promise<void>;

export class UiServer {
  private server: ReturnType<typeof createServer>;
  private wss: WebSocketServer | null = null;
  private port: number;
  private project: string;
  private graphUiPath: string;
  private humanStore: HumanMemoryStore;
  private codeReader: CodeGraphReader | undefined;
  // R17: in-memory index job tracking. Keyed by job ID (string).
  private indexJobs: Map<string, { id: string; status: string; error?: string; started_at: string; project: string }> = new Map();
  // R17: in-memory log buffer (ring buffer, max 500 lines).
  private logBuffer: string[] = [];
  private static readonly LOG_BUFFER_MAX = 500;
  // R25: set of connected WebSocket clients (for cleanup on stop).
  private wsClients: Set<WebSocket> = new Set();
  // R25: unsubscribe function for the notification hub.
  private hubUnsubscribe: (() => void) | null = null;
  // R41 (L1): route-table dispatcher. Replaces a 580-line chain of
  // `if (path === '/api/...' && req.method === '...')` blocks with a
  // Map<string, RouteHandler> lookup. Each value is an arrow function
  // that delegates to a private async routeXxx method. Order matches
  // source order of the original if-blocks for documentation readability.
  private routes: Map<string, RouteHandler> = new Map([
    ['GET /api/layout',          (u, r, s, p) => this.routeLayout(u, r, s, p)],
    ['GET /api/projects',        (u, r, s, p) => this.routeProjects(u, r, s, p)],
    ['GET /api/project-health',  (u, r, s, p) => this.routeProjectHealth(u, r, s, p)],
    ['GET /api/dashboard',       (u, r, s, p) => this.routeDashboard(u, r, s, p)],
    ['GET /api/human-notes',     (u, r, s, p) => this.routeHumanNotes(u, r, s, p)],
    ['GET /api/graph-status',    (u, r, s, p) => this.routeGraphStatus(u, r, s, p)],
    ['GET /api/adr',             (u, r, s, p) => this.routeAdrGet(u, r, s, p)],
    ['POST /api/adr',            (u, r, s, p) => this.routeAdrPost(u, r, s, p)],
    ['GET /api/browse',          (u, r, s, p) => this.routeBrowse(u, r, s, p)],
    ['POST /api/index',          (u, r, s, p) => this.routeIndex(u, r, s, p)],
    ['GET /api/index-status',    (u, r, s, p) => this.routeIndexStatus(u, r, s, p)],
    ['GET /api/processes',       (u, r, s, p) => this.routeProcesses(u, r, s, p)],
    ['POST /api/process-kill',   (u, r, s, p) => this.routeProcessKill(u, r, s, p)],
    ['POST /api/project-delete', (u, r, s, p) => this.routeProjectDelete(u, r, s, p)],
    ['GET /api/logs',            (u, r, s, p) => this.routeLogs(u, r, s, p)],
  ]);

  constructor(opts: UiServerOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.project = opts.project;
    this.graphUiPath = opts.graphUiPath ?? resolve(process.cwd(), '..', 'graph-ui', 'dist');

    this.humanStore = new HumanMemoryStore(defaultHumanDbPath(this.project));
    // R25: attach the notification hub so store mutations push events.
    this.humanStore.attachNotifyHub(getNotifyHub(), this.project);

    try {
      this.codeReader = new CodeGraphReader(defaultCodeDbPath(this.project));
    } catch {
      // Code graph not available
    }

    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  /**
   * Append a line to the in-memory log buffer. Used by /api/logs.
   * The buffer is a ring buffer — oldest lines are dropped when full.
   */
  private log(line: string): void {
    this.logBuffer.push(`[${new Date().toISOString()}] ${line}`);
    if (this.logBuffer.length > UiServer.LOG_BUFFER_MAX) {
      this.logBuffer.shift();
    }
  }

  /**
   * Parse a JSON body from an IncomingMessage. Returns null on parse error
   * or missing body. Caps at 1MB to prevent abuse. R23: added 30s timeout
   * to prevent pending-forever on suspended connections.
   */
  private async parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      let resolved = false;
      const MAX_BODY = 1024 * 1024; // 1MB
      const TIMEOUT_MS = 30000; // 30 seconds

      const finish = (value: Record<string, unknown> | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(value);
      };

      // R23: timeout to prevent pending-forever on suspended connections.
      const timer = setTimeout(() => {
        req.destroy();
        finish(null);
      }, TIMEOUT_MS);

      req.on('data', (chunk: Buffer) => {
        totalSize += chunk.length;
        if (totalSize > MAX_BODY) {
          // Too large — destroy the stream and resolve null.
          req.destroy();
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) {
          finish(null);
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            finish(null);
            return;
          }
          finish(body as Record<string, unknown>);
        } catch {
          finish(null);
        }
      });
      req.on('error', () => finish(null));
    });
  }

  start(): void {
    this.server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`Port ${this.port} is already in use. Use --port to specify a different port.`);
      } else {
        console.error('Server error:', e.message);
      }
      // R34: close DB handles before exiting (same fix as R26 Bug #6 for MCP server).
      try {
        this.humanStore.close();
        this.codeReader?.close();
      } catch { /* ignore close errors during shutdown */ }
      process.exit(1);
    });
    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`[cbm-v2 ui] Graph UI server running at http://127.0.0.1:${this.port}`);
    });

    // R25: WebSocket server — shares the same HTTP port via upgrade.
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleWsConnection(ws, req);
    });

    // R25: subscribe to the notification hub. When the store mutates,
    // broadcast to all connected WebSocket clients.
    this.hubUnsubscribe = getNotifyHub().subscribe((event) => {
      this.broadcastToWsClients(event);
    });
  }

  stop(): void {
    // R25: unsubscribe from the hub and close all WebSocket clients.
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

  /**
   * R25: Handle a new WebSocket connection.
   * Clients send a subscribe message with their project, then receive
   * push notifications for that project.
   */
  private handleWsConnection(ws: WebSocket, _req: IncomingMessage): void {
    this.wsClients.add(ws);

    // Send a welcome message so the client knows the connection is live.
    this.sendWsMessage(ws, {
      type: 'connected',
      project: this.project,
      timestamp: new Date().toISOString(),
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        // R25: support 'ping' keepalive (client → server).
        if (msg.type === 'ping') {
          this.sendWsMessage(ws, { type: 'pong', timestamp: new Date().toISOString() });
        }
        // R25: support 'subscribe' to filter by project.
        if (msg.type === 'subscribe' && typeof msg.project === 'string') {
          // Store the project filter on the WebSocket instance.
          (ws as any)._projectFilter = msg.project;
        }
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      this.wsClients.delete(ws);
    });

    ws.on('error', () => {
      this.wsClients.delete(ws);
    });
  }

  /**
   * R25: Broadcast a notification event to all connected WebSocket clients.
   * Only sends to clients whose project filter matches the event's project
   * (or clients that haven't set a filter — they get everything).
   */
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
      // Check project filter — only send if it matches or is not set.
      const filter = (ws as any)._projectFilter;
      if (filter && filter !== event.project) continue;
      try {
        ws.send(payload);
      } catch {
        // send failed — remove the client
        this.wsClients.delete(ws);
      }
    }
  }

  /**
   * R25: Send a JSON message to a single WebSocket client.
   */
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

    // Track whether a response has been sent. If handleApi/serveStatic already
    // sent a response and THEN throws, we must NOT attempt to send a 500 —
    // calling res.writeHead() after headers are sent throws ERR_STREAM_WRITE_AFTER_END.
    let responseSent = false;
    const markSent = () => { responseSent = true; };
    res.on('finish', markSent);
    res.on('close', markSent);

    try {
      // API routes
      if (path.startsWith('/api/')) {
        await this.handleApi(path, url, req, res);
        return;
      }

      // Static files
      if (path === '/' || path === '/index.html') {
        this.serveStatic('/index.html', res);
        return;
      }

      // Try to serve static asset
      this.serveStatic(path, res);
    } catch (e: any) {
      if (responseSent || res.writableEnded) {
        // Response already sent — log the error but don't try to write again.
        process.stderr.write(`[cbm-v2 ui] post-response error: ${e.message}\n`);
        return;
      }
      this.sendJson(res, 500, { error: e.message });
    }
  }

  /**
   * R41 (L1): route-table dispatcher. Replaces a 580-line chain of
   * `if (path === '/api/...' && req.method === '...')` blocks with a
   * Map<string, RouteHandler> lookup. The project query parameter is
   * extracted once here (DRY) and passed to each route handler.
   * Per-route exceptions propagate up to handleRequest's try/catch
   * (lines 297-326 of the pre-R41 source) which converts them to 500s.
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
      this.sendJson(res, 404, { error: `Unknown API endpoint: ${path}` });
      return;
    }
    await handler.call(this, url, req, res, project);
  }

  // ── R41 (L1): route handlers ──────────────────────────────────────────
  // Each method below is the verbatim body of the original
  // "if (path === '/api/...' && req.method === '...')" block from the old
  // handleApi. No logic changes — only moved into a private async method
  // and de-indented one level. Unused parameters are prefixed with `_`
  // to satisfy noUnusedParameters.

  // GET /api/layout — graph layout data (2D, computed on-the-fly)
  private async routeLayout(url: URL, _req: IncomingMessage, res: ServerResponse, project: string): Promise<void> {
    if (!this.codeReader) {
      this.sendJson(res, 404, { error: 'Code graph not available' });
      return;
    }
    // R20: clamp maxNodes to [1, 10000] to prevent DoS via negative limit
    // (SQLite treats LIMIT -1 as "no limit", which could return millions of rows).
    const rawMaxNodes = parseInt(url.searchParams.get('max_nodes') ?? '2000', 10);
    const maxNodes = Math.max(1, Math.min(10000, Number.isFinite(rawMaxNodes) ? rawMaxNodes : 2000));
    const nodes = this.codeReader.listNodes(project, { limit: maxNodes });
    const nodeIds = nodes.map((n) => n.id);
    const degreeMap = this.codeReader.getBulkNodeDegrees(nodeIds);

    // Assign simple layout positions (ring layout, will be refined by d3-force in browser)
    const notesByNode = this.humanStore.getBulkNotesByCbmNodeIds(project, nodeIds, 1);
    const layoutNodes = nodes.map((n, i) => {
      const angle = (i / nodes.length) * Math.PI * 2;
      const radius = 200 + (n.id % 100);
      const degree = degreeMap.get(n.id) ?? 0;
      const props = safeJsonParse(n.properties_json, {} as Record<string, any>);
      const complexity = props.complexity_avg ?? props.complexity ?? 0;
      const notesCount = notesByNode.get(n.id)?.length ?? 0;
      const riskScore = computeRiskScore(degree, complexity, notesCount);

      return {
        id: n.id,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        label: n.label,
        name: n.name,
        file_path: n.file_path,
        qualified_name: n.qualified_name,
        start_line: n.start_line,
        end_line: n.end_line,
        size: Math.max(3, Math.min(12, Math.sqrt(degree) + 3)),
        color: this.colorForLabel(n.label),
        risk_score: riskScore,
        notes_count: notesCount,
      };
    });

    // Fetch edges in BULK (2 chunked queries) instead of N+1 getNeighbors calls.
    // For 2000 nodes, this replaces ~2000 queries with ~4 queries (-99.8%).
    // limitPerNode=20 matches the previous per-node cap from getNeighbors.
    const edges = this.codeReader.getBulkEdges(nodeIds, 20);

    this.sendJson(res, 200, {
      nodes: layoutNodes,
      edges,
      total_nodes: this.codeReader.countNodes(project),
    });
    return;
  }

  // GET /api/projects — list indexed projects with health info
  private async routeProjects(_url: URL, _req: IncomingMessage, res: ServerResponse, _project: string): Promise<void> {
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
      // R41 (L3): readdirSync is now a static import — no dynamic import needed.
      const files = readdirSync(cbmDir);
      for (const f of files) {
        if (f.endsWith('.db') && !f.endsWith('.human.db') && !f.startsWith('_')) {
          const name = f.replace(/\.db$/, '');
          const dbPath = join(cbmDir, f);
          const stat = statSync(dbPath);
          // R15: open each DB read-only to get node/edge counts for the
          // ProjectCard. Previously the card always showed "Loading schema..."
          // because no counts were provided.
          let nodeCount: number | undefined;
          let edgeCount: number | undefined;
          let status = 'healthy';
          // R41 (L2+N2): use the new countAll single-query method (2 → 1
          // query per project) and close the reader in a finally block so
          // the handle is released even if countAll throws (corrupt schema).
          // The previous code skipped reader.close() on exception, leaking
          // the better-sqlite3 handle (file lock on Windows until GC).
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
    this.sendJson(res, 200, { projects });
    return;
  }

  // GET /api/project-health — check DB integrity
  private async routeProjectHealth(url: URL, _req: IncomingMessage, res: ServerResponse, project: string): Promise<void> {
    const name = url.searchParams.get('name') ?? project;
    const dbPath = defaultCodeDbPath(name);
    if (!existsSync(dbPath)) {
      this.sendJson(res, 200, { name, status: 'missing', reason: 'DB file not found' });
      return;
    }
    try {
      const reader = new CodeGraphReader(dbPath);
      const nodes = reader.countNodes(name);
      const edges = reader.countEdges(name);
      const stat = statSync(dbPath);
      reader.close();
      this.sendJson(res, 200, {
        name,
        status: 'healthy',
        nodes,
        edges,
        size_bytes: stat.size,
      });
    } catch (e: any) {
      this.sendJson(res, 200, { name, status: 'corrupt', reason: e.message });
    }
    return;
  }

  // GET /api/dashboard — V2 dashboard data
  private async routeDashboard(_url: URL, _req: IncomingMessage, res: ServerResponse, project: string): Promise<void> {
    const graphStatus = getGraphStatus(project, this.codeReader, process.cwd());
    const freshnessScore = getFreshnessScore(graphStatus);

    // R38: single GROUP BY query instead of 5 separate COUNT queries.
    const labelCounts = this.humanStore.countNodesByLabel(project);
    const adrs = labelCounts['ADR'] ?? 0;
    const bugs = labelCounts['BugNote'] ?? 0;
    const refactors = labelCounts['RefactorPlan'] ?? 0;
    const conventions = labelCounts['Convention'] ?? 0;
    const totalNotes = labelCounts['_total'] ?? 0;

    let criticalTotal = 0;
    let criticalDocumented = 0;
    if (this.codeReader) {
      const modules = this.codeReader.listModules(project, MAX_NODES_PER_LABEL);
      const moduleIds = modules.map((m) => m.id);
      const degreeMap = this.codeReader.getBulkNodeDegrees(moduleIds);
      const criticalIds = modules.filter(m => (degreeMap.get(m.id) ?? 0) >= 20).map(m => m.id);
      const notesByNode = this.humanStore.getBulkNotesByCbmNodeIds(project, criticalIds, 1);
      for (const m of modules) {
        if ((degreeMap.get(m.id) ?? 0) >= 20) {
          criticalTotal++;
        }
      }
      for (const id of criticalIds) {
        if ((notesByNode.get(id)?.length ?? 0) > 0) criticalDocumented++;
      }
    }

    const recommendations: string[] = [];
    if (graphStatus.stale) {
      recommendations.push(`Refresh code graph: ${graphStatus.stale_reason}. Run "cbm index_repository".`);
    }
    if (bugs > 0) {
      recommendations.push(`${bugs} open bug(s) — review before making changes.`);
    }
    if (refactors > 0) {
      recommendations.push(`${refactors} pending refactor plan(s) — check if your work overlaps.`);
    }
    if (criticalTotal > 0 && criticalDocumented < criticalTotal) {
      recommendations.push(`Documentation coverage is ${((criticalDocumented / criticalTotal) * 100).toFixed(0)}% — ${criticalTotal - criticalDocumented} critical module(s) undocumented.`);
    }
    if (recommendations.length === 0) {
      recommendations.push('Project is in good shape. Use prepare_edit_context before modifying any file.');
    }

    this.sendJson(res, 200, {
      project,
      generated_at: new Date().toISOString(),
      code_graph: this.codeReader
        ? {
            total_nodes: this.codeReader.countNodes(project),
            total_edges: this.codeReader.countEdges(project),
            nodes_by_label: this.codeReader.countNodesByLabel(project),
          }
        : { total_nodes: 0, total_edges: 0, nodes_by_label: {} },
      human_memory: {
        total_notes: totalNotes,
        adrs,
        bugs,
        refactors,
        conventions,
      },
      documentation_coverage: {
        critical_modules_total: criticalTotal,
        critical_modules_documented: criticalDocumented,
        coverage_pct: criticalTotal > 0 ? (criticalDocumented / criticalTotal) * 100 : null,
      },
      graph_status: {
        ...graphStatus,
        freshness_score: freshnessScore,
        freshness_label: freshnessLabel(freshnessScore),
      },
      recommendations,
    });
    return;
  }

  // GET /api/human-notes — V2 human notes for a code node
  private async routeHumanNotes(url: URL, _req: IncomingMessage, res: ServerResponse, project: string): Promise<void> {
    const cbmNodeId = url.searchParams.get('cbm_node_id');
    let notes;
    if (cbmNodeId) {
      const n = parseInt(cbmNodeId, 10);
      if (!Number.isFinite(n)) {
        this.sendJson(res, 400, { error: "invalid cbm_node_id" });
        return;
      }
      notes = this.humanStore.listNodesByCbmNodeId(project, n);
    } else {
      notes = this.humanStore.listNodes(project, { limit: 100 });
    }
    this.sendJson(res, 200, {
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
    return;
  }

  // GET /api/graph-status — V2 graph freshness
  private async routeGraphStatus(_url: URL, _req: IncomingMessage, res: ServerResponse, project: string): Promise<void> {
    const status = getGraphStatus(project, this.codeReader, process.cwd());
    const score = getFreshnessScore(status);
    this.sendJson(res, 200, {
      ...status,
      freshness_score: score,
      freshness_label: freshnessLabel(score),
    });
    return;
  }

  // ── R17: 7 new endpoints ──────────────────────────────────────────

  // GET /api/adr — list all ADR notes for the project
  private async routeAdrGet(_url: URL, _req: IncomingMessage, res: ServerResponse, project: string): Promise<void> {
    const adrs = this.humanStore.listNodes(project, { label: 'ADR', limit: 500 });
    if (adrs.length === 0) {
      this.sendJson(res, 200, { has_adr: false });
      return;
    }
    // Return the most recent ADR's content + a list of all ADRs.
    const latest = adrs[0];
    this.sendJson(res, 200, {
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
    return;
  }

  // POST /api/adr — create or update an ADR note
  private async routeAdrPost(_url: URL, req: IncomingMessage, res: ServerResponse, project: string): Promise<void> {
    const body = await this.parseJsonBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const content = typeof body.content === 'string' ? body.content : '';
    const title = typeof body.title === 'string' ? body.title : `ADR-${Date.now().toString(36)}`;
    const adrProject = typeof body.project === 'string' ? body.project : project;
    try {
      // Check if an ADR with this title already exists; if so, update it.
      const existing = this.humanStore.listNodes(adrProject, { label: 'ADR', limit: 500 })
        .find((a) => a.title === title);
      let node;
      if (existing) {
        node = this.humanStore.updateNode(existing.id, { body_markdown: content });
      } else {
        node = this.humanStore.createNode({
          project: adrProject,
          label: 'ADR',
          title,
          body_markdown: content,
          source: 'human',
          status: 'active',
          tags: ['adr'],
        });
      }
      this.log(`ADR saved: id=${node!.id} title="${title}"`);
      this.sendJson(res, 200, {
        success: true,
        id: node!.id,
        title: node!.title,
        slug: node!.slug,
        obsidian_path: node!.obsidian_path,
        updated_at: node!.updated_at,
      });
    } catch (e: any) {
      this.sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // GET /api/browse — file picker (list directories)
  private async routeBrowse(url: URL, _req: IncomingMessage, res: ServerResponse, _project: string): Promise<void> {
    const queryPath = url.searchParams.get('path');
    let targetPath: string;
    if (queryPath) {
      targetPath = resolve(queryPath);
    } else {
      // Default: home directory
      targetPath = homedir();
    }
    try {
      if (!existsSync(targetPath)) {
        this.sendJson(res, 404, { error: `Path not found: ${targetPath}` });
        return;
      }
      const stat = statSync(targetPath);
      if (!stat.isDirectory()) {
        this.sendJson(res, 400, { error: 'Path is not a directory' });
        return;
      }
      const entries = readdirSync(targetPath, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort();
      const parent = dirname(targetPath) === targetPath ? '' : dirname(targetPath);
      // Detect filesystem roots (Unix: /, Windows: C:\, D:\, etc.)
      const roots: string[] = [];
      if (process.platform === 'win32') {
        // Windows: list drive letters
        for (let i = 65; i <= 90; i++) {
          const drive = String.fromCharCode(i) + ':\\';
          if (existsSync(drive)) roots.push(drive);
        }
      } else {
        roots.push('/');
      }
      this.sendJson(res, 200, {
        path: targetPath,
        dirs,
        roots,
        parent,
      });
    } catch (e: any) {
      this.sendJson(res, 500, { error: e.message });
    }
    return;
  }

  // POST /api/index — trigger a V1 index job (async, returns job ID)
  private async routeIndex(_url: URL, req: IncomingMessage, res: ServerResponse, _project: string): Promise<void> {
    const body = await this.parseJsonBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const rootPath = typeof body.root_path === 'string' ? body.root_path : '';
    const projectName = typeof body.project_name === 'string' ? body.project_name : '';
    if (!rootPath || !projectName) {
      this.sendJson(res, 400, { error: 'root_path and project_name are required' });
      return;
    }
    if (!existsSync(rootPath)) {
      this.sendJson(res, 404, { error: `root_path not found: ${rootPath}` });
      return;
    }
    // Generate a job ID and track it. The actual indexing is done by V1's
    // `cbm index_repository` command — we spawn it as a subprocess.
    const jobId = `idx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const job: { id: string; status: string; error?: string; started_at: string; project: string } = { id: jobId, status: 'pending', started_at: new Date().toISOString(), project: projectName };
    this.indexJobs.set(jobId, job);
    this.log(`Index job started: id=${jobId} project="${projectName}" root="${rootPath}"`);

    // Spawn the V1 indexer. We use `cbm` if available, otherwise `npx cbm`.
    // The job status is updated in-memory when the process exits.
    // R41 (L3): spawn is now a static import.
    try {
      const child = spawn('cbm', ['index_repository', '--project', projectName, rootPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      job.status = 'running';
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (err) => {
        job.status = 'failed';
        job.error = `spawn error: ${err.message}`;
        this.log(`Index job ${jobId} failed: ${err.message}`);
      });
      child.on('exit', (code) => {
        if (code === 0) {
          job.status = 'completed';
          this.log(`Index job ${jobId} completed`);
        } else {
          job.status = 'failed';
          job.error = `exit code ${code}: ${stderr.slice(0, 500)}`;
          this.log(`Index job ${jobId} failed (exit ${code})`);
        }
      });
    } catch (e: any) {
      job.status = 'failed';
      job.error = e.message;
      this.log(`Index job ${jobId} failed to start: ${e.message}`);
    }

    this.sendJson(res, 202, { job_id: jobId, status: job.status });
    return;
  }

  // GET /api/index-status — list all index jobs
  private async routeIndexStatus(_url: URL, _req: IncomingMessage, res: ServerResponse, _project: string): Promise<void> {
    const jobs = [...this.indexJobs.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
    // Clean up old completed/failed jobs (keep last 50)
    if (this.indexJobs.size > 50) {
      const toKeep = new Set(jobs.slice(0, 50).map((j) => j.id));
      for (const id of this.indexJobs.keys()) {
        if (!toKeep.has(id)) this.indexJobs.delete(id);
      }
    }
    this.sendJson(res, 200, { jobs });
    return;
  }

  // GET /api/processes — list running cbm/cbm-v2 processes
  private async routeProcesses(_url: URL, _req: IncomingMessage, res: ServerResponse, _project: string): Promise<void> {
    const currentPid = process.pid;
    const processes: Array<{ pid: number; cpu: number; rss_mb: number; elapsed: string; command: string; is_self: boolean }> = [];
    try {
      // Use `ps` to list processes (Unix only). On Windows, return empty.
      if (process.platform !== 'win32') {
        // R41 (L3): execSync is now a static import.
        // ps aux — filter for cbm/cbm-v2/node processes
        const output = execSync('ps aux 2>/dev/null | grep -E "cbm|node" | grep -v grep', {
          encoding: 'utf-8',
          timeout: 5000,
        });
        const lines = output.split('\n').filter((l) => l.trim().length > 0);
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
          processes.push({
            pid,
            cpu,
            rss_mb: Math.round(rssKb / 1024),
            elapsed: parts[9] || 'unknown',
            command,
            is_self: pid === currentPid,
          });
        }
      }
    } catch {
      // ps not available or failed — return empty list
    }
    this.sendJson(res, 200, { processes });
    return;
  }

  // POST /api/process-kill — kill a process by PID
  private async routeProcessKill(_url: URL, req: IncomingMessage, res: ServerResponse, _project: string): Promise<void> {
    const body = await this.parseJsonBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const pid = typeof body.pid === 'number' ? body.pid : parseInt(String(body.pid), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      this.sendJson(res, 400, { error: 'pid must be a positive number' });
      return;
    }
    // Defense: refuse to kill ourselves
    if (pid === process.pid) {
      this.sendJson(res, 400, { error: 'Cannot kill the UI server itself' });
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
      this.log(`Process killed: pid=${pid}`);
      this.sendJson(res, 200, { success: true, pid, signal: 'SIGTERM' });
    } catch (e: any) {
      this.sendJson(res, 500, { error: `Failed to kill pid ${pid}: ${e.message}` });
    }
    return;
  }

  // POST /api/project-delete — delete a project's code graph DB
  private async routeProjectDelete(_url: URL, req: IncomingMessage, res: ServerResponse, _project: string): Promise<void> {
    const body = await this.parseJsonBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.sendJson(res, 400, { error: 'Invalid project name (alphanumeric, dash, underscore only)' });
      return;
    }
    // Defense: refuse to delete the currently active project
    if (name === this.project) {
      this.sendJson(res, 400, { error: 'Cannot delete the currently active project. Stop the UI server first.' });
      return;
    }
    const dbPath = defaultCodeDbPath(name);
    const humanDbPath = defaultHumanDbPath(name);
    try {
      // R41 (L3): unlinkSync is now a static import.
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
      this.log(`Project deleted: name="${name}" db=${dbPath}`);
      this.sendJson(res, 200, { success: true, name, deleted, db_path: dbPath });
    } catch (e: any) {
      this.sendJson(res, 500, { error: `Failed to delete project: ${e.message}` });
    }
    return;
  }

  // GET /api/logs — return recent log lines
  private async routeLogs(url: URL, _req: IncomingMessage, res: ServerResponse, _project: string): Promise<void> {
    const linesParam = url.searchParams.get('lines');
    const lines = linesParam ? Math.min(Math.max(parseInt(linesParam, 10) || 100, 1), 500) : 100;
    const recent = this.logBuffer.slice(-lines);
    this.sendJson(res, 200, { lines: recent });
    return;
  }

  private serveStatic(path: string, res: ServerResponse): void {
    const filePath = resolve(this.graphUiPath, path === '/' ? 'index.html' : path);
    // Defense-in-depth: verify the resolved path stays within the graphUiPath.
    if (!filePath.startsWith(resolve(this.graphUiPath) + sep)) {
      this.sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    if (!existsSync(filePath)) {
      this.sendJson(res, 404, { error: 'File not found' });
      return;
    }
    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
    const data = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  private colorForLabel(label: string): string {
    const colors: Record<string, string> = {
      Function: '#60a5fa',
      Method: '#818cf8',
      Class: '#a78bfa',
      Interface: '#c084fc',
      Module: '#34d399',
      File: '#6b7280',
      Route: '#fbbf24',
      Package: '#f97316',
      Variable: '#94a3b8',
      Resource: '#ec4899',
      Channel: '#14b8a6',
    };
    return colors[label] ?? '#7dd3fc';
  }
}
