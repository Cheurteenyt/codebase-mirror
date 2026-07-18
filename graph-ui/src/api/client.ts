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
  GraphNeighborhoodData,
  GraphPathData,
  GraphNodeSearchData,
  GraphScopeData,
  GraphScopeKind,
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
  constructor(public code: number, message: string, public details?: unknown) {
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
  // R49 (#7): store the abort listener so we can remove it in finally.
  // Without this, a long-lived external signal accumulates listeners.
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, body.message ?? body.error ?? `HTTP ${res.status}`, body);
    }
    return res.json() as Promise<T>;
  } catch (e: unknown) {
    // Distinguish abort (timeout or external) from real network errors.
    if (e instanceof ApiError) throw e;
    if ((e instanceof Error && e.name === "AbortError") || controller.signal.aborted) {
      // R49 (#6): distinguish timeout (our timer) from external abort (caller's signal).
      // The old code always said "timed out" even when the caller cancelled at 50ms.
      const reason = signal?.aborted ? "Request aborted by caller" : `Request timed out after ${timeoutMs}ms`;
      throw new ApiError(0, reason);
    }
    // Network error (DNS, connection refused, CORS) — wrap for consistent shape.
    throw new ApiError(0, (e instanceof Error ? e.message : "Network error"));
  } finally {
    clearTimeout(timer);
    // R49 (#7): remove the external-signal listener to prevent leaks.
    if (signal && !signal.aborted) signal.removeEventListener("abort", onExternalAbort);
  }
}

export interface SecurityBootstrap {
  csrf_token: string;
}

let securityBootstrapPromise: Promise<SecurityBootstrap> | null = null;

/** Fetch and cache the runtime-only same-origin CSRF/WebSocket credential. */
export function getSecurityBootstrap(forceRefresh = false): Promise<SecurityBootstrap> {
  if (forceRefresh) securityBootstrapPromise = null;
  if (!securityBootstrapPromise) {
    securityBootstrapPromise = fetchJson<SecurityBootstrap>(`${API_BASE}/api/bootstrap`)
      .catch((error: unknown) => {
        securityBootstrapPromise = null;
        throw error;
      });
  }
  return securityBootstrapPromise;
}

/**
 * POST JSON with timeout and optional external cancellation.
 * Same error semantics as fetchJson.
 */
async function postJson<T>(url: string, body: unknown, opts: FetchOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const send = async (forceRefresh = false) => {
      const bootstrap = await getSecurityBootstrap(forceRefresh);
      return fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CBM-CSRF": bootstrap.csrf_token,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    };

    let res = await send();
    if (res.status === 403) {
      const rejectedBody = await res.clone().json().catch(() => ({}));
      if (rejectedBody.error === "Invalid CSRF token") res = await send(true);
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, errBody.message ?? errBody.error ?? `HTTP ${res.status}`, errBody);
    }
    return res.json() as Promise<T>;
  } catch (e: unknown) {
    if (e instanceof ApiError) throw e;
    if ((e instanceof Error && e.name === "AbortError") || controller.signal.aborted) {
      // R49 (#6): distinguish timeout from external abort.
      const reason = signal?.aborted ? "Request aborted by caller" : `Request timed out after ${timeoutMs}ms`;
      throw new ApiError(0, reason);
    }
    throw new ApiError(0, (e instanceof Error ? e.message : "Network error"));
  } finally {
    clearTimeout(timer);
    if (signal && !signal.aborted) signal.removeEventListener("abort", onExternalAbort);
  }
}

export const api = {
  // ── Graph data ────────────────────────────────────────────────
  getLayout: (project: string, maxNodes = 2000, opts?: FetchOptions) =>
    fetchJson<GraphData>(
      `${API_BASE}/api/layout?project=${encodeURIComponent(project)}&max_nodes=${maxNodes}`,
      opts,
    ),

  getNeighborhood: (project: string, nodeId: number, cursor?: string | null, opts?: FetchOptions) => {
    const params = new URLSearchParams({
      project,
      node_id: String(nodeId),
      limit: "250",
    });
    if (cursor) params.set("cursor", cursor);
    return fetchJson<GraphNeighborhoodData>(`${API_BASE}/api/neighborhood?${params}`, {
      timeoutMs: 8_000,
      ...opts,
    });
  },

  getPath: (project: string, sourceId: number, targetId: number, opts?: FetchOptions) => (
    fetchJson<GraphPathData>(`${API_BASE}/api/path?project=${encodeURIComponent(project)}&source_id=${sourceId}&target_id=${targetId}&max_hops=6`, {
      timeoutMs: 8_000,
      ...opts,
    })
  ),

  searchNodes: (project: string, query: string, cursor?: string | null, opts?: FetchOptions) => {
    const params = new URLSearchParams({
      project,
      q: query,
      limit: "50",
    });
    if (cursor) params.set("cursor", cursor);
    return fetchJson<GraphNodeSearchData>(`${API_BASE}/api/node-search?${params}`, {
      timeoutMs: 8_000,
      ...opts,
    });
  },

  getScope: (
    project: string,
    kind: GraphScopeKind,
    key: string,
    cursor?: string | null,
    opts?: FetchOptions,
  ) => {
    const params = new URLSearchParams({ project, kind, key, limit: "125" });
    if (cursor) params.set("cursor", cursor);
    return fetchJson<GraphScopeData>(`${API_BASE}/api/scope?${params}`, {
      timeoutMs: 8_000,
      ...opts,
    });
  },

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
    postJson(
      `${API_BASE}/api/adr?project=${encodeURIComponent(project)}`,
      { project, content },
      opts,
    ),

  // ── Indexing ──────────────────────────────────────────────────
  triggerIndex: (rootPath: string, projectName: string, opts?: FetchOptions) =>
    postJson(`${API_BASE}/api/index`, { root_path: rootPath, project_name: projectName }, opts),

  getIndexStatus: (opts?: FetchOptions) =>
    fetchJson<{ jobs: Array<{ id: string; status: string; error?: string; started_at: string; project: string }> }>(
      `${API_BASE}/api/index-status`,
      opts,
    ),

  terminateIndexJob: (jobId: string, opts?: FetchOptions) =>
    postJson(
      `${API_BASE}/api/index-jobs/${encodeURIComponent(jobId)}/terminate`,
      {},
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

};
