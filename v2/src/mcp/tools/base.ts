// v2/src/mcp/tools/base.ts
// Base class for V2 MCP tools — provides arg helpers and consistent response shaping.

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
    // MCP payloads are consumed as structured JSON, so indentation only adds
    // transport bytes and model tokens without carrying information.
    return this.text(JSON.stringify(obj));
  }

  protected error(message: string) {
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
  }

  protected requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(
        `Missing or invalid argument: ${key} (non-empty string required, got ${v === undefined ? 'undefined' : v === null ? 'null' : typeof v}: ${JSON.stringify(v)})`
      );
    }
    return v;
  }

  protected optionalString(args: Record<string, unknown>, key: string): string | undefined {
    const v = args[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  }

  /**
   * Returns a valid number or undefined. Returns undefined for missing/invalid values
   * (instead of NaN). Throws for explicit-but-non-numeric values to give clear feedback.
   *
   * IMPORTANT: whitespace-only strings like " " are treated as missing (return undefined),
   * NOT as 0. This is because Number(" ") === 0 in JavaScript, which is almost never what
   * the caller intends — it would silently default a missing optional limit to 0 and
   * produce empty results.
   */
  protected optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
    const v = args[key];
    if (v == null) return undefined;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed === '') return undefined;
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        throw new Error(`Argument ${key} must be a number, got string "${v}"`);
      }
      return n;
    }
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    throw new Error(`Argument ${key} must be a number, got ${typeof v}`);
  }

  protected optionalArray(args: Record<string, unknown>, key: string): unknown[] | undefined {
    const v = args[key];
    return Array.isArray(v) ? v : undefined;
  }

  /**
   * Require a number argument; throws if missing or not a finite number.
   * Whitespace-only strings are rejected (not treated as 0).
   */
  protected requireNumber(args: Record<string, unknown>, key: string): number {
    const v = args[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed === '') {
        throw new Error(
          `Missing or invalid argument: ${key} (number required, got empty/whitespace string)`
        );
      }
      const n = Number(trimmed);
      if (Number.isFinite(n)) return n;
    }
    throw new Error(
      `Missing or invalid argument: ${key} (number required, got ${v === undefined ? 'undefined' : typeof v}: ${JSON.stringify(v)})`
    );
  }

  /**
   * Validate that a value is one of an allowed set (enum).
   */
  protected requireEnum<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T {
    const v = args[key];
    if (typeof v !== 'string' || !allowed.includes(v as T)) {
      throw new Error(
        `Missing or invalid argument: ${key} (must be one of: ${allowed.join(', ')}, got ${JSON.stringify(v)})`
      );
    }
    return v as T;
  }
}
