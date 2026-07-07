// v2/src/ui/types.ts
// R63: shared types for the UI server. Extracted from server.ts to enable
// route handlers to live in separate files (routes/*.ts) without importing
// the full UiServer class.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HumanMemoryStore } from '../human/store.js';
import type { CodeGraphReader } from '../bridge/sqlite-ro.js';

/**
 * Index job tracking entry. R17: in-memory, keyed by job ID (string).
 * R51 (SEC-8): childPid is cleared to undefined when the process exits,
 * so a recycled PID can't be killed via /api/process-kill.
 */
export interface IndexJob {
  id: string;
  status: string;
  error?: string;
  started_at: string;
  project: string;
  childPid?: number;
}

/**
 * Route handler signature. Each /api/* endpoint receives the route context,
 * the parsed URL, the request, the response, and the resolved project name.
 * Routes that don't use `project` (e.g. /api/projects lists all projects)
 * simply ignore the parameter.
 */
export type RouteHandler = (
  ctx: RouteContext,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  project: string,
) => Promise<void>;

/**
 * Route context: the shared dependencies that every route handler needs.
 * Passed by UiServer.handleApi so routes don't need to be methods of UiServer
 * — they can be standalone functions in routes/*.ts.
 *
 * R63: this is the key abstraction that enables the server.ts split. Before
 * R63, routes accessed `this.humanStore`, `this.codeReader`, etc. via the
 * UiServer instance. Now they receive a RouteContext, which is an explicit
 * dependency declaration — the compiler catches missing fields, and routes
 * can be unit-tested with a mock context.
 */
export interface RouteContext {
  humanStore: HumanMemoryStore;
  codeReader: CodeGraphReader | undefined;
  project: string;
  port: number;
  graphUiPath: string;
  indexJobs: Map<string, IndexJob>;
  logBuffer: string[];
  log: (line: string) => void;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}
