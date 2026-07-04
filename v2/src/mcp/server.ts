// v2/src/mcp/server.ts
// Minimal MCP server (JSON-RPC 2.0 over stdio) — implements V2 tools.
// We don't depend on @modelcontextprotocol/sdk to keep deps minimal;
// the protocol is straightforward.

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

export class McpServer {
  private rl: Interface;
  private handlers: Map<string, ToolHandler & { definition: any }>;
  private pending: Set<Promise<void>> = new Set();

  constructor(private opts: McpServerOptions) {
    this.rl = createInterface({ input: process.stdin, terminal: false });
    this.handlers = new Map();
    for (const tool of TOOL_CLASSES) {
      const instance = new tool(this.opts);
      this.handlers.set(instance.definition.name, instance);
    }
  }

  async run(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.rl.on('line', (line) => {
        const p = this.handleLine(line)
          .catch((e) => {
            this.sendError(null, -32603, `Internal error: ${e.message}`);
          })
          .finally(() => {
            this.pending.delete(p);
          });
        this.pending.add(p);
      });

      this.rl.on('close', async () => {
        // Wait for all pending requests to complete before resolving
        await Promise.allSettled([...this.pending]);
        resolve();
      });
    });
  }

  private async handleLine(line: string): Promise<void> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      this.sendError(null, -32700, 'Parse error');
      return;
    }

    if (req.method === 'initialize') {
      this.sendResult(req.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'codebase-memory-v2',
          version: '0.1.0',
        },
      });
      return;
    }

    if (req.method === 'notifications/initialized') {
      // No response needed for notifications
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
      const { name, arguments: args } = req.params || {};
      const handler = this.handlers.get(name);
      if (!handler) {
        this.sendError(req.id, -32601, `Tool not found: ${name}`);
        return;
      }
      try {
        const result = await handler.handle(args || {});
        this.sendResult(req.id, result);
      } catch (e: any) {
        this.sendError(req.id, -32603, `Tool error: ${e.message}`);
      }
      return;
    }

    this.sendError(req.id, -32601, `Method not found: ${req.method}`);
  }

  private sendResult(id: string | number | null | undefined, result: any): void {
    if (id == null) return;
    const resp: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    process.stdout.write(JSON.stringify(resp) + '\n');
  }

  private sendError(id: string | number | null | undefined, code: number, message: string): void {
    if (id == null) return;
    const resp: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
    process.stdout.write(JSON.stringify(resp) + '\n');
  }
}
