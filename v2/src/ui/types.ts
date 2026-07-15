// v2/src/ui/types.ts
// R63: shared types for the UI server. Extracted from server.ts to enable
// route handlers to live in separate files (routes/*.ts) without importing
// the full UiServer class.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type { HumanMemoryStore } from '../human/store.js';
import type { CodeGraphReader } from '../bridge/sqlite-ro.js';

/** Internal index job state. Child handles and timers never enter API DTOs. */
export type IndexJobStatus =
  | 'pending'
  | 'running'
  | 'terminating'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface IndexJob {
  id: string;
  status: IndexJobStatus;
  error?: string;
  started_at: string;
  project: string;
  rootPath: string;
  child?: ChildProcess;
  stderrTail: string;
  timeoutTimer?: NodeJS.Timeout;
  forceKillTimer?: NodeJS.Timeout;
  exitDrainTimer?: NodeJS.Timeout;
  terminationReason?: 'requested' | 'timeout' | 'shutdown';
  treeKillInProgress?: boolean;
  treeKillPromise?: Promise<void>;
  treeKiller?: ChildProcess;
  treeKillTimeout?: NodeJS.Timeout;
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
  refreshCodeReader: (project: string) => CodeGraphReader;
  resolveProjectName: (project: string) => string;
  isProjectStoreOpen: (project: string) => boolean;
  getAllowedRoots: () => string[];
  indexJobTimeoutMs: number;
  indexJobTerminationGraceMs: number;
  maxConcurrentIndexJobs: number;
  maxConcurrentIndexJobsPerProject: number;
  isStopping: () => boolean;
  getIndexerLaunch: (rootPath: string, project: string) => { command: string; args: string[] };
  logBuffer: string[];
  log: (line: string) => void;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
}
