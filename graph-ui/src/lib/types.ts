// graph-ui/src/lib/types.ts
// Core type definitions for the V2 graph UI.
// Designed to be compatible with V1 data shapes while adding V2 concepts
// (human memory, risk scores, graph freshness).

// ── Code Graph Types (from V1 SQLite, via /api/layout) ──────────

export interface GraphNode {
  id: number;
  x: number;
  y: number;
  label: string;
  name: string;
  file_path?: string;
  qualified_name?: string;
  start_line?: number;
  end_line?: number;
  size: number;
  color: string;
  /** Dead-code classification from the layout engine. */
  status?: NodeStatus;
  in_calls?: number;
  /** V2: risk score (0.0-1.0) from computeRiskScore. */
  risk_score?: number;
  /** V2: number of human notes linked to this node. */
  notes_count?: number;
}

export type NodeStatus =
  | "dead"
  | "single"
  | "entry"
  | "test"
  | "exported"
  | "normal"
  | "structural";

export interface GraphEdge {
  source: number;
  target: number;
  type: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  total_nodes: number;
}

// ── Project Types ────────────────────────────────────────────────

export interface Project {
  name: string;
  root_path: string;
  indexed_at: string;
  node_count?: number;
  edge_count?: number;
  size_bytes?: number;
  status?: string;
}

export interface ProjectHealth {
  name: string;
  status: "healthy" | "corrupt" | "missing";
  nodes?: number;
  edges?: number;
  size_bytes?: number;
  reason?: string;
}

export interface SchemaInfo {
  node_labels: { label: string; count: number }[];
  edge_types: { type: string; count: number }[];
  total_nodes: number;
  total_edges: number;
}

// ── V2: Human Memory Types ──────────────────────────────────────

export interface HumanNote {
  id: number;
  label: string;
  title: string;
  status: string;
  body_excerpt?: string;
  obsidian_path?: string | null;
  updated_at: string;
}

export interface HumanMemorySummary {
  total_notes: number;
  adrs: number;
  bugs: number;
  refactors: number;
  conventions: number;
}

// ── V2: Graph Freshness ─────────────────────────────────────────

export interface GraphStatus {
  available: boolean;
  last_indexed: string | null;
  age_seconds: number | null;
  stale: boolean;
  stale_reason: string | null;
  stale_files_count: number;
  stale_files_sample: string[];
  total_nodes: number;
  total_edges: number;
  freshness_score: number;
  freshness_label: "FRESH" | "RECENT" | "STALE" | "OLD" | "CRITICAL";
  recommendation: string;
}

// ── V2: Dashboard ───────────────────────────────────────────────

export interface DashboardData {
  project: string;
  generated_at: string;
  code_graph: {
    total_nodes: number;
    total_edges: number;
    nodes_by_label: Record<string, number>;
  };
  human_memory: HumanMemorySummary;
  documentation_coverage: {
    critical_modules_total: number;
    critical_modules_documented: number;
    coverage_pct: number | null;
  };
  graph_status: GraphStatus;
  recommendations: string[];
}

// ── UI State Types ──────────────────────────────────────────────

export type TabId = "dashboard" | "graph" | "stats" | "control";

export interface ProcessInfo {
  pid: number;
  cpu: number;
  rss_mb: number;
  elapsed: string;
  command: string;
  is_self: boolean;
}

/** Git remote metadata for building GitHub deep-links. */
export interface RepoInfo {
  root_path: string;
  branch: string;
  remote_url: string;
  web_base: string;
  blob_base: string;
}
