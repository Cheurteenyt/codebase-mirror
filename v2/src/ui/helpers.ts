// v2/src/ui/helpers.ts
// R63: shared helpers and constants for the UI server. Extracted from
// server.ts so route handlers in routes/*.ts can use them without importing
// the full UiServer class.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** Default port for the UI server. Overridable via UiServerOptions.port. */
export const DEFAULT_PORT = 9749;

/** Maximum log lines kept in the in-memory ring buffer. */
export const LOG_BUFFER_MAX = 500;

/** Maximum request body size (1MB). Prevents abuse via oversized POST bodies. */
export const MAX_BODY_SIZE = 1024 * 1024;

/** Request body parse timeout. Prevents pending-forever on suspended connections. */
export const BODY_TIMEOUT_MS = 30000;

/**
 * MIME type lookup for static file serving. Falls back to
 * 'application/octet-stream' for unknown extensions.
 */
export const MIME_TYPES: Record<string, string> = {
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

/**
 * Send a JSON HTTP response. Writes the status code and Content-Type header,
 * then ends the response with the JSON-serialized body.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Safely extract a message from an unknown caught value.
 * R61: replaces `catch (e: any) { ... e.message }` which would throw if
 * `e` was not an Error object (e.g. `throw "string"` or `throw { code: 42 }`).
 *
 * Usage:
 *   try { ... } catch (e: unknown) {
 *     sendJson(res, 500, { error: errorMessage(e) });
 *   }
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}

/**
 * Color for a code node label, used by the graph layout endpoint.
 * Returns a light-blue fallback for unknown labels.
 */
export function colorForLabel(label: string): string {
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

/**
 * Parse a JSON body from an IncomingMessage. Returns null on parse error
 * or missing body. Caps at MAX_BODY_SIZE (1MB) to prevent abuse.
 * R23: added 30s timeout to prevent pending-forever on suspended connections.
 *
 * R63: moved from UiServer.parseJsonBody() to a standalone helper so route
 * handlers in routes/*.ts can use it without needing the UiServer instance.
 */
export function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let resolved = false;

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
    }, BODY_TIMEOUT_MS);

    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
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
