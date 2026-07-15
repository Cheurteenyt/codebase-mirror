// v2/src/mcp/server.ts
// Minimal MCP server (JSON-RPC 2.0 over stdio) — implements V2 tools.
// We don't depend on @modelcontextprotocol/sdk to keep deps minimal.

import { createInterface, Interface } from 'node:readline';
import { createRequire } from 'node:module';
import { HumanMemoryStore } from '../human/store.js';
import { CodeGraphReader } from '../bridge/sqlite-ro.js';
import { ToolHandler, ALL_TOOLS, TOOL_CLASSES } from './tools/index.js';
import { MCP_MAX_LINE_LENGTH } from '../constants.js';

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

// MCP_MAX_LINE_LENGTH imported from constants.ts

// Read version from package.json at runtime for a fail-closed single source of
// truth. A fabricated fallback version makes protocol diagnostics actively
// misleading when an artifact is incomplete.
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version?: unknown };
if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
  throw new Error('Invalid package.json: a non-empty version is required');
}
const SERVER_VERSION = packageJson.version;

const CURRENT_PROTOCOL_VERSION = '2025-11-25';
const ANNOTATED_PROTOCOL_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
]);
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  ...ANNOTATED_PROTOCOL_VERSIONS,
  '2024-11-05',
]);

export class McpServer {
  private rl: Interface;
  private handlers: Map<string, ToolHandler & { definition: any }>;
  private pending: Set<Promise<void>> = new Set();
  private initialized = false;
  private negotiatedProtocolVersion: string | undefined;

  constructor(private opts: McpServerOptions) {
    this.rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
    this.handlers = new Map();
    for (const tool of TOOL_CLASSES) {
      const instance = new tool(this.opts);
      this.handlers.set(instance.definition.name, instance);
    }

    // Graceful shutdown on signals.
    // R26 (Bug #6 fix): close DB handles before process.exit to ensure
    // WAL checkpoints are flushed cleanly.
    const shutdown = (signal: string) => {
      process.stderr.write(`[cbm-v2 mcp] received ${signal}, shutting down...\n`);
      Promise.allSettled([...this.pending]).finally(() => {
        try {
          this.opts.humanStore.close();
          this.opts.codeReader?.close();
        } catch {
          // ignore close errors during shutdown
        }
        process.exit(0);
      });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  async run(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.rl.on('line', (line) => {
        // Protect against huge payloads.
        if (line.length > MCP_MAX_LINE_LENGTH) {
          process.stderr.write(`[cbm-v2 mcp] dropping line exceeding ${MCP_MAX_LINE_LENGTH} bytes\n`);
          return;
        }
        const p = this.handleLine(line)
          .catch((e) => {
            process.stderr.write(`[cbm-v2 mcp] internal error: ${(e instanceof Error ? e.message : String(e))}\n`);
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
    } catch (e: unknown) {
      // Per spec, parse errors should still get a response with id: null.
      this.sendResponse(null, {
        code: JSONRPC_ERROR_CODES.PARSE_ERROR,
        message: `Parse error: ${(e instanceof Error ? e.message : String(e))}`,
      });
      return;
    }

    // MCP removed JSON-RPC batching in 2025-06-18. This compact server does
    // not implement the optional legacy 2025-03-26 batch response shape
    // either; in particular, initialize must never appear in a batch.
    if (Array.isArray(parsed)) {
      this.sendResponse(null, {
        code: JSONRPC_ERROR_CODES.INVALID_REQUEST,
        message: 'Invalid Request: JSON-RPC batching is not supported',
      });
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
      // The initialized notification only completes an initialize handshake;
      // it must never create one. Without this guard, a client could send the
      // notification first and immediately gain access to tools/call without
      // negotiating a protocol version or receiving server capabilities.
      if (this.negotiatedProtocolVersion === undefined) {
        process.stderr.write('[cbm-v2 mcp] ignoring notifications/initialized received before initialize\n');
        return;
      }
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
      const requestedVersion = typeof req.params?.protocolVersion === 'string'
        ? req.params.protocolVersion
        : CURRENT_PROTOCOL_VERSION;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
        ? requestedVersion
        : CURRENT_PROTOCOL_VERSION;
      this.negotiatedProtocolVersion = protocolVersion;
      this.sendResult(req.id, {
        protocolVersion,
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
      const includeAnnotations = this.negotiatedProtocolVersion === undefined
        || ANNOTATED_PROTOCOL_VERSIONS.has(this.negotiatedProtocolVersion);
      const tools = ALL_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(includeAnnotations ? { annotations: t.annotations } : {}),
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
      } catch (e: unknown) {
        this.sendError(req.id, JSONRPC_ERROR_CODES.INTERNAL_ERROR, `Tool "${name}" error: ${(e instanceof Error ? e.message : String(e))}`);
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
    if (id === undefined) return; // only true notifications (absent id) get no response
    const resp: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    process.stdout.write(JSON.stringify(resp) + '\n');
  }

  private sendError(id: string | number | null | undefined, code: number, message: string): void {
    // Per JSON-RPC 2.0: only ABSENT id (undefined = notification) gets no response.
    // id: null is a VALID request identifier and MUST get a response (e.g., parse errors).
    if (id === undefined) {
      process.stderr.write(`[cbm-v2 mcp] notification error (code ${code}): ${message}\n`);
      return;
    }
    // id can be string | number | null — all get a response on stdout.
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
