// graph-ui/src/lib/types.ts
// Core type definitions for the V2 graph UI.
// Designed to be compatible with V1 data shapes while adding V2 concepts
// (human memory, risk scores, graph freshness).

// ── Code Graph Types (from V1 SQLite, via /api/layout) ──────────

export interface GraphNode {
  id: number;
  x: number;
  y: number;
  /** Directory community assigned by the server-side structured layout. */
  cluster_id?: number;
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
  /** Exact full-graph degree counts; the overview edge list may be sampled. */
  in_degree?: number;
  out_degree?: number;
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
  /** Versioned HTTP layout contract; optional only for legacy/test fixtures. */
  contract_version?: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
  total_nodes: number;
  returned_nodes?: number;
  /** Opaque revision shared by layout, exact search, and exact neighborhood reads. */
  graph_revision?: string;
  /** Stable for metadata/filter changes; changes when the server topology changes. */
  topology_revision?: string;
  truncated?: boolean;
  sampling?: {
    strategy: string;
    node_limit: number;
    available_by_label: Record<string, number>;
    returned_by_label: Record<string, number>;
  };
  edge_sampling?: {
    strategy: string;
    total_induced_edges: number;
    returned_edges: number;
    edges_truncated: boolean;
    limit_per_direction: number;
    available_by_type: Record<string, number>;
    returned_by_type: Record<string, number>;
  };
  layout?: {
    strategy: string;
    /** World-space node spacing used by semantic zoom thresholds. */
    node_spacing: number;
    /** Hierarchy counts describe returned overview nodes, not hidden samples. */
    counts_scope: "returned_nodes";
    clusters: Array<{
      id: number;
      domain_id: number;
      key: string;
      x: number;
      y: number;
      radius: number;
      node_count: number;
    }>;
    domains: Array<{
      id: number;
      key: string;
      x: number;
      y: number;
      radius: number;
      node_count: number;
      cluster_count: number;
    }>;
    domain_catalog?: {
      exact: true;
      counts_scope: "all_nodes";
      total_domains: number;
      domains: Array<{
        key: string;
        node_count: number;
        file_count: number;
        representative_node_id: number;
      }>;
    };
  };
}

export interface GraphNeighborhoodData {
  contract_version: 1;
  exact: true;
  /** Immutable for every page merged into this exact result. */
  graph_revision: string;
  anchor: {
    kind: "node";
    id: number;
    total_inbound: number;
    total_outbound: number;
    total_unique_edges: number;
  };
  nodes: GraphNode[];
  edges: Array<GraphEdge & { id: number }>;
  page: {
    limit: number;
    returned: number;
    next_cursor: string | null;
  };
}

export interface GraphNodeSearchData {
  contract_version: 1;
  exact: true;
  /** Immutable for every page merged into this exact result. */
  graph_revision: string;
  scope: "complete_project";
  query: string;
  match_strategy: "literal-relevance-v1";
  total_matches: number;
  returned_nodes: number;
  truncated: boolean;
  nodes: GraphNode[];
  page: {
    limit: number;
    returned: number;
    next_cursor: string | null;
  };
}

export type GraphScopeKind = "domain" | "community";

export interface GraphScopeData {
  contract_version: 1;
  exact: true;
  graph_revision: string;
  scope: {
    kind: GraphScopeKind;
    key: string;
    total_nodes: number;
    total_internal_edges: number;
  };
  nodes: GraphNode[];
  edges: Array<GraphEdge & { id: number }>;
  complete: boolean;
  page: {
    node_limit: number;
    edge_limit: number;
    returned_nodes: number;
    returned_edges: number;
    next_cursor: string | null;
  };
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
  /** Historical BugNote total, including reviewed/deprecated notes. */
  bugs: number;
  active_bugs: number;
  /** Historical RefactorPlan total, including reviewed/deprecated notes. */
  refactors: number;
  active_refactors: number;
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
    scanned_modules: number;
    module_scan_limit: number;
    scan_truncated: boolean;
    critical_counts_are_lower_bounds: boolean;
    coverage_is_partial: boolean;
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
