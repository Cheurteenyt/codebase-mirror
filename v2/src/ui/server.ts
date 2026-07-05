// v2/src/ui/server.ts
// V2 HTTP server for the graph UI.
// Replaces V1's C-based http_server.c with a clean Node.js implementation.
// Serves static assets + API endpoints that read from the V2 stores.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { homedir } from 'node:os';
import { HumanMemoryStore, defaultHumanDbPath } from '../human/store.js';
import { CodeGraphReader, defaultCodeDbPath } from '../bridge/sqlite-ro.js';
import { getGraphStatus, getFreshnessScore, freshnessLabel } from '../intelligence/graph-status.js';
import { computeRiskScore } from '../reports/risk.js';
import { safeJsonParse, MAX_NODES_PER_LABEL } from '../constants.js';

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

export class UiServer {
  private server: ReturnType<typeof createServer>;
  private port: number;
  private project: string;
  private graphUiPath: string;
  private humanStore: HumanMemoryStore;
  private codeReader: CodeGraphReader | undefined;

  constructor(opts: UiServerOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.project = opts.project;
    this.graphUiPath = opts.graphUiPath ?? resolve(process.cwd(), '..', 'graph-ui', 'dist');

    this.humanStore = new HumanMemoryStore(defaultHumanDbPath(this.project));
    try {
      this.codeReader = new CodeGraphReader(defaultCodeDbPath(this.project));
    } catch {
      // Code graph not available
    }

    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  start(): void {
    this.server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`Port ${this.port} is already in use. Use --port to specify a different port.`);
      } else {
        console.error('Server error:', e.message);
      }
      process.exit(1);
    });
    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`[cbm-v2 ui] Graph UI server running at http://127.0.0.1:${this.port}`);
    });
  }

  stop(): void {
    this.server.close();
    this.humanStore.close();
    this.codeReader?.close();
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

  private async handleApi(
    path: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const project = url.searchParams.get('project') ?? this.project;

    // GET /api/layout — graph layout data (2D, computed on-the-fly)
    if (path === '/api/layout' && req.method === 'GET') {
      if (!this.codeReader) {
        this.sendJson(res, 404, { error: 'Code graph not available' });
        return;
      }
      const maxNodes = parseInt(url.searchParams.get('max_nodes') ?? '2000', 10);
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
    if (path === '/api/projects' && req.method === 'GET') {
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
        const { readdirSync } = await import('node:fs');
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
            try {
              const reader = new CodeGraphReader(dbPath);
              nodeCount = reader.countNodes(name);
              edgeCount = reader.countEdges(name);
              reader.close();
            } catch {
              status = 'corrupt';
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
    if (path === '/api/project-health' && req.method === 'GET') {
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
    if (path === '/api/dashboard' && req.method === 'GET') {
      const graphStatus = getGraphStatus(project, this.codeReader, process.cwd());
      const freshnessScore = getFreshnessScore(graphStatus);

      const adrs = this.humanStore.countNodes(project, 'ADR');
      const bugs = this.humanStore.countNodes(project, 'BugNote');
      const refactors = this.humanStore.countNodes(project, 'RefactorPlan');
      const conventions = this.humanStore.countNodes(project, 'Convention');
      const totalNotes = this.humanStore.countNodes(project);

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
    if (path === '/api/human-notes' && req.method === 'GET') {
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
    if (path === '/api/graph-status' && req.method === 'GET') {
      const status = getGraphStatus(project, this.codeReader, process.cwd());
      const score = getFreshnessScore(status);
      this.sendJson(res, 200, {
        ...status,
        freshness_score: score,
        freshness_label: freshnessLabel(score),
      });
      return;
    }

    // 404
    this.sendJson(res, 404, { error: `Unknown API endpoint: ${path}` });
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
