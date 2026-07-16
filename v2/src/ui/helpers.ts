// v2/src/ui/helpers.ts
// R63: shared helpers and constants for the UI server. Extracted from
// server.ts so route handlers in routes/*.ts can use them without importing
// the full UiServer class.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import {
  brotliCompressSync,
  constants as zlibConstants,
  gzipSync,
} from 'node:zlib';

/** Default port for the UI server. Overridable via UiServerOptions.port. */
export const DEFAULT_PORT = 9749;

/** Maximum log lines kept in the in-memory ring buffer. */
export const LOG_BUFFER_MAX = 500;

/** Maximum request body size (1MB). Prevents abuse via oversized POST bodies. */
export const MAX_BODY_SIZE = 1024 * 1024;

/** Request body parse timeout. Prevents pending-forever on suspended connections. */
export const BODY_TIMEOUT_MS = 30000;

/** Avoid spending compression CPU on tiny API responses. */
const JSON_COMPRESSION_THRESHOLD = 1024;
const JSON_COMPRESSION_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const compressedJsonCache = new Map<string, Buffer>();
let compressedJsonCacheBytes = 0;

function acceptedEncodingQuality(header: string | undefined, encoding: string): number {
  if (!header) return 0;
  let wildcard: number | undefined;
  let exact: number | undefined;
  for (const part of header.split(',')) {
    const [rawName, ...parameters] = part.trim().toLowerCase().split(';');
    let quality = 1;
    for (const parameter of parameters) {
      const normalized = parameter.trim();
      if (!normalized.startsWith('q=')) continue;
      const match = /^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.exec(normalized);
      quality = match ? Number(match[1]) : 0;
    }
    if (rawName === encoding) exact = Math.max(exact ?? 0, quality);
    if (rawName === '*') wildcard = Math.max(wildcard ?? 0, quality);
  }
  return exact ?? wildcard ?? 0;
}

function appendVary(res: ServerResponse, token: string): void {
  const current = res.getHeader('Vary');
  const values = (Array.isArray(current) ? current.join(',') : String(current ?? ''))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.some((value) => value.toLowerCase() === token.toLowerCase())) values.push(token);
  res.setHeader('Vary', values.join(', '));
}

function ifNoneMatchAccepts(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  const opaqueTag = etag.replace(/^W\//u, '');
  return value.split(',').some((candidate) => {
    const normalized = candidate.trim();
    return normalized === '*'
      || normalized === etag
      || normalized.replace(/^W\//u, '') === opaqueTag;
  });
}

function cachedCompressedJson(
  key: string,
  compress: () => Buffer,
): Buffer {
  const cached = compressedJsonCache.get(key);
  if (cached) {
    // Refresh insertion order so eviction behaves as a small LRU.
    compressedJsonCache.delete(key);
    compressedJsonCache.set(key, cached);
    return cached;
  }
  const result = compress();
  if (result.byteLength > JSON_COMPRESSION_CACHE_MAX_BYTES) return result;
  compressedJsonCache.set(key, result);
  compressedJsonCacheBytes += result.byteLength;
  while (compressedJsonCacheBytes > JSON_COMPRESSION_CACHE_MAX_BYTES) {
    const oldestKey = compressedJsonCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = compressedJsonCache.get(oldestKey);
    compressedJsonCache.delete(oldestKey);
    compressedJsonCacheBytes -= oldest?.byteLength ?? 0;
  }
  return result;
}

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
  const payload = Buffer.from(JSON.stringify(body));
  const method = res.req?.method ?? 'GET';
  const cacheControl = String(res.getHeader('Cache-Control') ?? '');
  const cacheableGet = method === 'GET' && status === 200 && !/\bno-store\b/iu.test(cacheControl);
  const compressibleGet = cacheableGet && payload.byteLength >= JSON_COMPRESSION_THRESHOLD;
  let digest: string | undefined;

  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (compressibleGet) appendVary(res, 'Accept-Encoding');

  if (cacheableGet) {
    // A weak validator is correct across equivalent identity/gzip/Brotli
    // representations while still making unchanged refreshes bodyless.
    digest = createHash('sha256').update(payload).digest('base64url').slice(0, 22);
    const etag = `W/"${digest}"`;
    res.setHeader('ETag', etag);
    if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'private, no-cache');
    if (ifNoneMatchAccepts(res.req?.headers['if-none-match'], etag)) {
      res.statusCode = 304;
      res.removeHeader('Content-Type');
      res.end();
      return;
    }
  }

  let responsePayload: Uint8Array = payload;
  if (method !== 'HEAD' && compressibleGet) {
    const acceptEncoding = res.req?.headers['accept-encoding'];
    const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding;
    const brotliQuality = acceptedEncodingQuality(header, 'br');
    const gzipQuality = acceptedEncodingQuality(header, 'gzip');
    if (brotliQuality > 0 && brotliQuality >= gzipQuality) {
      responsePayload = cachedCompressedJson(`${digest}:br`, () => (
        brotliCompressSync(payload, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
        })
      ));
      res.setHeader('Content-Encoding', 'br');
    } else if (gzipQuality > 0) {
      responsePayload = cachedCompressedJson(
        `${digest}:gzip`,
        () => gzipSync(payload, { level: 6 }),
      );
      res.setHeader('Content-Encoding', 'gzip');
    }
  }

  res.setHeader('Content-Length', responsePayload.byteLength);
  res.end(method === 'HEAD' ? undefined : responsePayload);
}

/**
 * Safely extract a message from an unknown caught value.
 * R61: replaces `catch (e: any) { ... e.message }` which would throw if
 * `e` was not an Error object (e.g. `throw "string"` or `throw { code: 42 }`).
 *
 * Usage:
 *   try { ... } catch (e: unknown) {
 *     log(errorMessage(e));
 *     sendJson(res, 500, { error: 'Internal server error' });
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
