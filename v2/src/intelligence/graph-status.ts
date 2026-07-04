// v2/src/intelligence/graph-status.ts
// Graph freshness detection — knows if the code graph is stale, how stale,
// and what files changed since the last index.

import { CodeGraphReader, defaultCodeDbPath } from '../bridge/sqlite-ro.js';
import { existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

// File extensions that are NOT code (excluded from stale file detection).
const NON_CODE_EXTENSIONS = new Set([
  'md', 'json', 'lock', 'yml', 'yaml', 'txt', 'gitignore', 'toml',
  'map', 'd.ts', 'license', 'env', 'dockerignore', 'editorconfig',
]);

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
  nodes_by_label: Record<string, number>;
  recommendation: string;
}

export function getGraphStatus(
  project: string,
  codeReader: CodeGraphReader | undefined,
  projectRoot: string
): GraphStatus {
  const status: GraphStatus = {
    available: false,
    last_indexed: null,
    age_seconds: null,
    stale: false,
    stale_reason: null,
    stale_files_count: 0,
    stale_files_sample: [],
    total_nodes: 0,
    total_edges: 0,
    nodes_by_label: {},
    recommendation: '',
  };

  if (!codeReader) {
    status.recommendation = 'Code graph not available. Run "cbm index_repository" to build it.';
    return status;
  }

  status.available = true;

  // Use the SAME path construction as CodeGraphReader to avoid divergence.
  const dbPath = defaultCodeDbPath(project);
  let dbMtime: Date | null = null;
  if (existsSync(dbPath)) {
    const stat = statSync(dbPath);
    dbMtime = stat.mtime;
    status.last_indexed = dbMtime.toISOString();
    status.age_seconds = Math.floor((Date.now() - dbMtime.getTime()) / 1000);
  }

  // Graph stats.
  try {
    status.total_nodes = codeReader.countNodes(project);
    status.total_edges = codeReader.countEdges(project);
    status.nodes_by_label = codeReader.countNodesByLabel(project);
  } catch {
    // ignore — graph may be empty or corrupt
  }

  // Detect stale files via git (uses Unix timestamp for cross-platform compat).
  if (dbMtime && existsSync(join(projectRoot, '.git'))) {
    try {
      const unixTs = Math.floor(dbMtime.getTime() / 1000);
      const gitResult = execSync(
        `git log --name-only --pretty=format: --since="@${unixTs}" --diff-filter=ACMRTUXB 2>/dev/null | sort -u | grep -v '^$' | head -100`,
        { cwd: projectRoot, encoding: 'utf-8', timeout: 5000 }
      ).trim();

      if (gitResult) {
        const changedFiles = gitResult.split('\n').filter((f) => f.length > 0);
        const codeFiles = changedFiles.filter((f) => {
          // Skip dotfiles (no real extension) and known non-code extensions.
          const lastDot = f.lastIndexOf('.');
          if (lastDot === -1 || lastDot === 0) return false; // no extension or dotfile
          const ext = f.substring(lastDot + 1).toLowerCase();
          return !NON_CODE_EXTENSIONS.has(ext);
        });
        status.stale_files_count = codeFiles.length;
        status.stale_files_sample = codeFiles.slice(0, 10);
      }
    } catch {
      // git not available or not a git repo — fall back to age-only check below.
    }
  }

  // Determine staleness (either git-detected files or age-based).
  if (status.stale_files_count > 0) {
    status.stale = true;
    status.stale_reason = `${status.stale_files_count} source file(s) modified since last index`;
  } else if (status.age_seconds !== null && status.age_seconds > 3600) {
    status.stale = true;
    status.stale_reason = `Code graph is ${Math.floor(status.age_seconds / 3600)}h old`;
  }

  // Recommendation.
  if (status.stale) {
    status.recommendation = `STALE: ${status.stale_reason}. Run "cbm index_repository" to refresh.`;
  } else if (status.total_nodes === 0) {
    status.recommendation = 'Code graph is empty. Run "cbm index_repository".';
  } else {
    status.recommendation = 'FRESH';
  }

  return status;
}

export function getFreshnessScore(status: GraphStatus): number {
  if (!status.available || status.total_nodes === 0) return 0.0;
  if (status.stale_files_count > 50) return 0.2;
  if (status.stale_files_count > 10) return 0.4;
  if (status.stale_files_count > 0) return 0.6;
  if (status.age_seconds !== null && status.age_seconds > 86400) return 0.5;
  if (status.age_seconds !== null && status.age_seconds > 3600) return 0.8;
  return 1.0;
}

export function freshnessLabel(score: number): string {
  if (score >= 0.9) return 'FRESH';
  if (score >= 0.7) return 'RECENT';
  if (score >= 0.5) return 'STALE';
  if (score >= 0.3) return 'OLD';
  return 'CRITICAL';
}
