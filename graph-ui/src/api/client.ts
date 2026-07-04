// graph-ui/src/api/client.ts
// HTTP client for the V2 UI server.
// All API calls go through here — single point for error handling and retry.

import type {
  GraphData,
  Project,
  ProjectHealth,
  DashboardData,
  HumanNote,
  GraphStatus,
} from "../lib/types";

const API_BASE = "";

class ApiError extends Error {
  constructor(public code: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, errBody.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // ── Graph data ────────────────────────────────────────────────
  getLayout: (project: string, maxNodes = 2000) =>
    fetchJson<GraphData>(
      `${API_BASE}/api/layout?project=${encodeURIComponent(project)}&max_nodes=${maxNodes}`,
    ),

  // ── Projects ──────────────────────────────────────────────────
  getProjects: () => fetchJson<{ projects: Project[] }>(`${API_BASE}/api/projects`),

  getProjectHealth: (name: string) =>
    fetchJson<ProjectHealth>(
      `${API_BASE}/api/project-health?name=${encodeURIComponent(name)}`,
    ),

  deleteProject: (name: string) =>
    postJson(`${API_BASE}/api/project-delete`, { name }),

  // ── V2: Dashboard ─────────────────────────────────────────────
  getDashboard: (project: string) =>
    fetchJson<DashboardData>(
      `${API_BASE}/api/dashboard?project=${encodeURIComponent(project)}`,
    ),

  // ── V2: Graph status ──────────────────────────────────────────
  getGraphStatus: (project: string) =>
    fetchJson<GraphStatus>(
      `${API_BASE}/api/graph-status?project=${encodeURIComponent(project)}`,
    ),

  // ── V2: Human notes ───────────────────────────────────────────
  getHumanNotes: (project: string, cbmNodeId?: number) => {
    const params = new URLSearchParams({ project });
    if (cbmNodeId != null) params.set("cbm_node_id", String(cbmNodeId));
    return fetchJson<{ notes: HumanNote[] }>(`${API_BASE}/api/human-notes?${params}`);
  },

  // ── ADR ───────────────────────────────────────────────────────
  getAdr: (project: string) =>
    fetchJson<{ has_adr: boolean; content?: string; updated_at?: string }>(
      `${API_BASE}/api/adr?project=${encodeURIComponent(project)}`,
    ),

  saveAdr: (project: string, content: string) =>
    postJson(`${API_BASE}/api/adr`, { project, content }),

  // ── Indexing ──────────────────────────────────────────────────
  triggerIndex: (rootPath: string, projectName: string) =>
    postJson(`${API_BASE}/api/index`, { root_path: rootPath, project_name: projectName }),

  getIndexStatus: () =>
    fetchJson<{ jobs: Array<{ id: string; status: string; error?: string }> }>(
      `${API_BASE}/api/index-status`,
    ),

  // ── Browse (file picker) ──────────────────────────────────────
  browse: (path?: string) => {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    return fetchJson<{
      path: string;
      dirs: string[];
      roots: string[];
      parent: string;
    }>(`${API_BASE}/api/browse${q}`);
  },

  // ── Logs ──────────────────────────────────────────────────────
  getLogs: (lines = 100) =>
    fetchJson<{ lines: string[] }>(`${API_BASE}/api/logs?lines=${lines}`),

  // ── Processes ─────────────────────────────────────────────────
  getProcesses: () =>
    fetchJson<{ processes: Array<{ pid: number; cpu: number; rss_mb: number; elapsed: string; command: string; is_self: boolean }> }>(
      `${API_BASE}/api/processes`,
    ),

  killProcess: (pid: number) =>
    postJson(`${API_BASE}/api/process-kill`, { pid }),
};
