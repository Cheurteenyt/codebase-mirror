// v2/src/mcp/server.ts
// Minimal MCP server (JSON-RPC 2.0 over stdio) — implements V2 tools.
// We don't depend on @modelcontextprotocol/sdk to keep deps minimal.

import { createInterface, Interface } from 'node:readline';
import { HumanMemoryStore } from '../human/store.js';
import { CodeGraphReader } from '../bridge/sqlite-ro.js';
import { ToolHandler, ALL_TOOLS, TOOL_CLASSES } from './tools/index.js';

export interface McpServerOptions {
  project: string;
  humanStore: HumanMemoryStore;
  codeReader?: CodeGraphReader;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

const JSONRPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

const MAX_LINE_LENGTH = 10 * 1024 * 1024; // 10M UTF-16 code units (~20-40MB UTF-8) — protects against OOM.

// Read package.json version lazily (avoids JSON import assertions complexity).
let SERVER_VERSION = '0.2.2';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = await import('node:fs');
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
  if (pkg.version) SERVER_VERSION = pkg.version;
} catch {
  // keep default
}

export class McpServer {
  private rl: Interface;
  private handlers: Map<string, ToolHandler & { definition: any }>;
  private pending: Set<Promise<void>> = new Set();
  private initialized = false;

  constructor(private opts: McpServerOptions) {
    this.rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
    this.handlers = new Map();
    for (const tool of TOOL_CLASSES) {
      const instance = new tool(this.opts);
      this.handlers.set(instance.definition.name, instance);
    }

    // Graceful shutdown on signals.
    const shutdown = (signal: string) => {
      process.stderr.write(`[cbm-v2 mcp] received ${signal}, shutting down...\n`);
      Promise.allSettled([...this.pending]).finally(() => process.exit(0));
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  async run(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.rl.on('line', (line) => {
        // Protect against huge payloads.
        if (line.length > MAX_LINE_LENGTH) {
          process.stderr.write(`[cbm-v2 mcp] dropping line exceeding ${MAX_LINE_LENGTH} bytes\n`);
          return;
        }
        const p = this.handleLine(line)
          .catch((e) => {
            process.stderr.write(`[cbm-v2 mcp] internal error: ${e.message}\n`);
          })
          .finally(() => {
            this.pending.delete(p);
          });
        this.pending.add(p);
      });

      this.rl.on('close', async () => {
        // Wait for all pending requests to complete before resolving.
        await Promise.allSettled([...this.pending]);
        resolve();
      });
    });
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e: any) {
      // Per spec, parse errors should still get a response with id: null.
      this.sendResponse(null, {
        code: JSONRPC_ERROR_CODES.PARSE_ERROR,
        message: `Parse error: ${e.message}`,
      });
      return;
    }

    // Handle batch requests (array of requests).
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        this.sendResponse(null, {
          code: JSONRPC_ERROR_CODES.INVALID_REQUEST,
          message: 'Invalid Request: batch array is empty',
        });
        return;
      }
      // Process each item sequentially (MCP doesn't strictly require parallel).
      for (const item of parsed) {
        await this.handleLine(JSON.stringify(item));
      }
      return;
    }

    // Validate it's a JSON-RPC 2.0 object.
    if (typeof parsed !== 'object' || parsed === null) {
      this.sendResponse(null, {
        code: JSONRPC_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid Request: not an object',
      });
      return;
    }
    const req = parsed as JsonRpcRequest;
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      this.sendResponse(req.id ?? null, {
        code: JSONRPC_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid Request: missing jsonrpc=2.0 or method',
      });
      return;
    }

    // Notifications (no id) get no response — we don't need a flag here, just check req.id later.

    // Handle notifications.
    if (req.method === 'notifications/initialized') {
      this.initialized = true;
      return; // no response
    }
    if (req.method === 'notifications/cancelled') {
      // Cancellation is best-effort; we don't have AbortController wiring yet.
      // Log and ignore (the in-flight handler will complete).
      process.stderr.write(`[cbm-v2 mcp] cancellation request for id=${req.params?.requestId} (not yet supported)\n`);
      return;
    }
    if (req.method.startsWith('notifications/')) {
      // Other notifications are silently ignored.
      return;
    }

    // Handle requests.
    if (req.method === 'initialize') {
      this.sendResult(req.id, {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: 'codebase-memory-v2',
          version: SERVER_VERSION,
        },
      });
      return;
    }

    if (req.method === 'ping') {
      this.sendResult(req.id, {});
      return;
    }

    if (req.method === 'tools/list') {
      const tools = ALL_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      this.sendResult(req.id, { tools });
      return;
    }

    if (req.method === 'tools/call') {
      // Require initialization first.
      if (!this.initialized) {
        this.sendError(req.id, JSONRPC_ERROR_CODES.INVALID_REQUEST, 'Server not initialized: send initialize first');
        return;
      }
      const { name, arguments: args } = req.params || {};
      if (typeof name !== 'string') {
        this.sendError(req.id, JSONRPC_ERROR_CODES.INVALID_PARAMS, 'tools/call requires params.name (string)');
        return;
      }
      const handler = this.handlers.get(name);
      if (!handler) {
        this.sendError(
          req.id,
          JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
          `Tool not found: ${name}. Available tools: ${[...this.handlers.keys()].join(', ')}`
        );
        return;
      }
      try {
        const result = await handler.handle(args || {});
        this.sendResult(req.id, result);
      } catch (e: any) {
        this.sendError(req.id, JSONRPC_ERROR_CODES.INTERNAL_ERROR, `Tool "${name}" error: ${e.message}`);
      }
      return;
    }

    // Unknown method.
    this.sendError(
      req.id,
      JSONRPC_ERROR_CODES.METHOD_NOT_FOUND,
      `Method not found: ${req.method}. Supported: initialize, notifications/initialized, ping, tools/list, tools/call`
    );
  }

  private sendResult(id: string | number | null | undefined, result: any): void {
    if (id == null) return; // notifications get no response
    const resp: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    process.stdout.write(JSON.stringify(resp) + '\n');
  }

  private sendError(id: string | number | null | undefined, code: number, message: string): void {
    if (id == null) {
      // For notifications, log to stderr instead.
      process.stderr.write(`[cbm-v2 mcp] error (code ${code}): ${message}\n`);
      return;
    }
    const resp: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
    process.stdout.write(JSON.stringify(resp) + '\n');
  }

  private sendResponse(id: string | number | null, error: { code: number; message: string; data?: any }): void {
    this.sendError(id, error.code, error.message);
  }
}
