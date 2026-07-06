// graph-ui/src/api/client.ts
// HTTP client for the V2 UI server.
// All API calls go through here — single point for error handling and retry.
//
// R45 (F1): added AbortController-based timeout (20s default). Previously,
// a hung backend (locked SQLite during large index) would leave `loading=true`
// forever with no recovery. Now requests throw ApiError(0, "timed out") after
// the timeout, and hooks can render "Backend may be busy — retry?".
//
// R45 (F1): ApiError is now exported so hooks can distinguish timeout (code=0)
// from server errors (code=HTTP status). Also supports per-call timeout
// override for slow endpoints (browse on NFS, dashboard on 10k modules).

import type {
  GraphData,
  Project,
  ProjectHealth,
  DashboardData,
  HumanNote,
  GraphStatus,
} from "../lib/types";

const API_BASE = "";

/** Default per-request timeout. Long enough for /api/layout on a 2000-node
 *  graph, short enough to recover from a locked-SQLite hang in <30s. */
const DEFAULT_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

interface FetchOptions {
  /** Per-call timeout override in milliseconds. Defaults to 20s. */
  timeoutMs?: number;
  /** External AbortSignal (e.g. from unmount cleanup) to cancel the request. */
  signal?: AbortSignal;
}

/**
 * Fetch JSON with timeout and optional external cancellation.
 * Throws ApiError(0, "timed out") on timeout, ApiError(status, msg) on HTTP error.
 */
async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // If caller supplied an external signal (e.g. unmount), forward its abort.
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  } catch (e: any) {
    // Distinguish abort (timeout or external) from real network errors.
    if (e instanceof ApiError) throw e;
    if (e?.name === "AbortError" || controller.signal.aborted) {
      throw new ApiError(0, `Request timed out after ${timeoutMs}ms`);
    }
    // Network error (DNS, connection refused, CORS) — wrap for consistent shape.
    throw new ApiError(0, e?.message ?? "Network error");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST JSON with timeout and optional external cancellation.
 * Same error semantics as fetchJson.
 */
async function postJson<T>(url: string, body: unknown, opts: FetchOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, errBody.error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    if (e?.name === "AbortError" || controller.signal.aborted) {
      throw new ApiError(0, `Request timed out after ${timeoutMs}ms`);
    }
    throw new ApiError(0, e?.message ?? "Network error");
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  // ── Graph data ────────────────────────────────────────────────
  getLayout: (project: string, maxNodes = 2000, opts?: FetchOptions) =>
    fetchJson<GraphData>(
      `${API_BASE}/api/layout?project=${encodeURIComponent(project)}&max_nodes=${maxNodes}`,
      opts,
    ),

  // ── Projects ──────────────────────────────────────────────────
  getProjects: (opts?: FetchOptions) =>
    fetchJson<{ projects: Project[] }>(`${API_BASE}/api/projects`, opts),

  getProjectHealth: (name: string, opts?: FetchOptions) =>
    fetchJson<ProjectHealth>(
      `${API_BASE}/api/project-health?name=${encodeURIComponent(name)}`,
      opts,
    ),

  deleteProject: (name: string, opts?: FetchOptions) =>
    postJson(`${API_BASE}/api/project-delete`, { name }, opts),

  // ── V2: Dashboard ─────────────────────────────────────────────
  // Dashboard computes risk scores over all modules — give it 30s on large
  // projects instead of the default 20s.
  getDashboard: (project: string, opts?: FetchOptions) =>
    fetchJson<DashboardData>(
      `${API_BASE}/api/dashboard?project=${encodeURIComponent(project)}`,
      { timeoutMs: 30_000, ...opts },
    ),

  // ── V2: Graph status ──────────────────────────────────────────
  getGraphStatus: (project: string, opts?: FetchOptions) =>
    fetchJson<GraphStatus>(
      `${API_BASE}/api/graph-status?project=${encodeURIComponent(project)}`,
      opts,
    ),

  // ── V2: Human notes ───────────────────────────────────────────
  getHumanNotes: (project: string, cbmNodeId?: number, opts?: FetchOptions) => {
    const params = new URLSearchParams({ project });
    if (cbmNodeId != null) params.set("cbm_node_id", String(cbmNodeId));
    return fetchJson<{ notes: HumanNote[] }>(`${API_BASE}/api/human-notes?${params}`, opts);
  },

  // ── ADR ───────────────────────────────────────────────────────
  getAdr: (project: string, opts?: FetchOptions) =>
    fetchJson<{ has_adr: boolean; content?: string; updated_at?: string }>(
      `${API_BASE}/api/adr?project=${encodeURIComponent(project)}`,
      opts,
    ),

  saveAdr: (project: string, content: string, opts?: FetchOptions) =>
    postJson(`${API_BASE}/api/adr`, { project, content }, opts),

  // ── Indexing ──────────────────────────────────────────────────
  triggerIndex: (rootPath: string, projectName: string, opts?: FetchOptions) =>
    postJson(`${API_BASE}/api/index`, { root_path: rootPath, project_name: projectName }, opts),

  getIndexStatus: (opts?: FetchOptions) =>
    fetchJson<{ jobs: Array<{ id: string; status: string; error?: string; started_at: string; project: string }> }>(
      `${API_BASE}/api/index-status`,
      opts,
    ),

  // ── Browse (file picker) ──────────────────────────────────────
  // Browsing a slow filesystem (NFS, network mount) may take longer than 20s.
  browse: (path?: string, opts?: FetchOptions) => {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    return fetchJson<{
      path: string;
      dirs: string[];
      roots: string[];
      parent: string;
    }>(`${API_BASE}/api/browse${q}`, { timeoutMs: 30_000, ...opts });
  },

  // ── Logs ──────────────────────────────────────────────────────
  getLogs: (lines = 100, opts?: FetchOptions) =>
    fetchJson<{ lines: string[] }>(`${API_BASE}/api/logs?lines=${lines}`, opts),

  // ── Processes ─────────────────────────────────────────────────
  getProcesses: (opts?: FetchOptions) =>
    fetchJson<{ processes: Array<{ pid: number; cpu: number; rss_mb: number; elapsed: string; command: string; is_self: boolean }> }>(
      `${API_BASE}/api/processes`,
      opts,
    ),

  killProcess: (pid: number, opts?: FetchOptions) =>
    postJson(`${API_BASE}/api/process-kill`, { pid }, opts),
};
