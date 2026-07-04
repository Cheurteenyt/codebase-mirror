// v2/src/constants.ts
// Shared constants to eliminate magic numbers across the codebase.

/** Maximum number of nodes to fetch per label in reports/generator. */
export const MAX_NODES_PER_LABEL = 5000;

/** Default limit for list queries (store, sqlite-ro, MCP tools). */
export const DEFAULT_LIST_LIMIT = 200;

/** Maximum slug length to avoid ENAMETOOLONG on most filesystems. */
export const MAX_SLUG_LENGTH = 200;

/** Maximum slug collision retry attempts (auto-suffix -2, -3, ... -100). */
export const SLUG_COLLISION_MAX_ATTEMPTS = 100;

/** SQLite variable limit (conservative; SQLite default is 999, newer is 32766). */
export const SQLITE_MAX_VARIABLES = 999;

// ── Degree thresholds ─────────────────────────────────────────────
export const DEGREE_CRITICAL = 20;
export const DEGREE_HIGH = 30;
export const DEGREE_VERY_HIGH = 40;
export const DEGREE_SEVERE = 50;
export const DEGREE_EXTREME = 60;
export const DEGREE_COUPLING_EXTREME = 80;
export const DEGREE_INTERFACE_FRAGILE = 10;
export const DEGREE_CENTRAL_FUNCTION = 20;
export const DEGREE_FUNCTION_HIGH = 30;
export const DEGREE_FUNCTION_EXTREME = 50;

// ── Risk score weights ────────────────────────────────────────────
export const RISK_WEIGHT_DEGREE = 0.5;
export const RISK_WEIGHT_COMPLEXITY = 0.3;
export const RISK_PENALTY_UNDOCUMENTED = 0.2;
export const RISK_LEVEL_HIGH = 0.7;
export const RISK_LEVEL_MEDIUM = 0.4;

// ── Complexity thresholds ─────────────────────────────────────────
export const COMPLEXITY_CRITICAL = 10;
export const COMPLEXITY_NORMALIZER = 20;

// ── Vault / sync ──────────────────────────────────────────────────
export const MAX_VAULT_DEPTH = 32;
export const MAX_BACKUPS_PER_FILE = 5;
export const SYNC_PAGE_SIZE = 500;
export const BULK_CHUNK_SIZE = 500;

// ── MCP / search ──────────────────────────────────────────────────
export const MCP_MAX_LINE_LENGTH = 10 * 1024 * 1024;
export const SEARCH_EXCERPT_LENGTH = 300;
export const CONTEXT_EXCERPT_LENGTH = 500;

// ── Code node labels (V1 schema) ──────────────────────────────────
export const CODE_NODE_LABELS = ['Module', 'Route', 'Function', 'Class', 'Interface'] as const;
export type CodeNodeLabel = (typeof CODE_NODE_LABELS)[number];

/**
 * Safely parse JSON, returning a default value on failure.
 * Use this instead of bare `JSON.parse(x || '{}')` to avoid crashes on corrupted data.
 */
export function safeJsonParse<T>(s: string | null | undefined, defaultValue: T): T {
  if (!s) return defaultValue;
  try {
    return JSON.parse(s) as T;
  } catch {
    return defaultValue;
  }
}
