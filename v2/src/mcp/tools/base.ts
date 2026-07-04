// v2/src/mcp/tools/base.ts
// Base class for V2 MCP tools.

import { McpServerOptions } from '../server.js';
import { HumanMemoryStore } from '../../human/store.js';
import { CodeGraphReader } from '../../bridge/sqlite-ro.js';
import { ToolDefinition, ToolHandler } from './index.js';

export abstract class BaseTool implements ToolHandler {
  protected opts: McpServerOptions;

  constructor(opts: McpServerOptions) {
    this.opts = opts;
  }

  protected get humanStore(): HumanMemoryStore {
    return this.opts.humanStore;
  }

  protected get codeReader(): CodeGraphReader | undefined {
    return this.opts.codeReader;
  }

  protected get project(): string {
    return this.opts.project;
  }

  abstract get definition(): ToolDefinition;
  abstract handle(args: Record<string, unknown>): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;

  protected text(text: string) {
    return { content: [{ type: 'text' as const, text }] };
  }

  protected json(obj: unknown) {
    return this.text(JSON.stringify(obj, null, 2));
  }

  protected error(message: string) {
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
  }

  protected requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`Missing or invalid argument: ${key} (string required)`);
    }
    return v;
  }

  protected optionalString(args: Record<string, unknown>, key: string): string | undefined {
    const v = args[key];
    return typeof v === 'string' ? v : undefined;
  }

  protected optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
    const v = args[key];
    return typeof v === 'number' ? v : v != null ? Number(v) : undefined;
  }

  protected optionalArray(args: Record<string, unknown>, key: string): unknown[] | undefined {
    const v = args[key];
    return Array.isArray(v) ? v : undefined;
  }
}
