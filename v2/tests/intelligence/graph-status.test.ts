// v2/tests/intelligence/graph-status.test.ts
// Tests for graph freshness detection.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  freshnessLabel,
  getFreshnessScore,
  getGraphStatus,
} from '../../src/intelligence/graph-status.js';
import type { GraphStatus } from '../../src/intelligence/graph-status.js';
import type { CodeGraphReader } from '../../src/bridge/sqlite-ro.js';

const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: childProcessMocks.execFileSync,
}));

describe('getFreshnessScore', () => {
  const base: GraphStatus = {
    available: true,
    last_indexed: new Date().toISOString(),
    age_seconds: 0,
    stale: false,
    stale_reason: null,
    stale_files_count: 0,
    stale_files_sample: [],
    total_nodes: 100,
    total_edges: 500,
    nodes_by_label: {},
    recommendation: 'FRESH',
    db_stale: null,
    db_semantics_version: null,
    db_semantics_current: null,
    last_index_error: null,
  };

  it('returns 1.0 for fresh graph (0 stale files, 0 age)', () => {
    expect(getFreshnessScore({ ...base })).toBe(1.0);
  });

  it('returns 0.0 for unavailable graph', () => {
    expect(getFreshnessScore({ ...base, available: false })).toBe(0.0);
  });

  it('returns 0.0 for empty graph (0 nodes)', () => {
    expect(getFreshnessScore({ ...base, total_nodes: 0 })).toBe(0.0);
  });

  it('returns 0.6 for 1-10 stale files', () => {
    expect(getFreshnessScore({ ...base, stale_files_count: 5 })).toBe(0.6);
  });

  it('returns 0.4 for 11-50 stale files', () => {
    expect(getFreshnessScore({ ...base, stale_files_count: 25 })).toBe(0.4);
  });

  it('returns 0.2 for >50 stale files', () => {
    expect(getFreshnessScore({ ...base, stale_files_count: 100 })).toBe(0.2);
  });

  it('returns 0.8 for age >1h but <24h (no stale files)', () => {
    expect(getFreshnessScore({ ...base, age_seconds: 7200 })).toBe(0.8);
  });

  it('returns 0.5 for age >24h (no stale files)', () => {
    expect(getFreshnessScore({ ...base, age_seconds: 100000 })).toBe(0.5);
  });

  it('prioritizes stale_files_count over age', () => {
    // 5 stale files + 100000s age → should use stale_files_count (0.6)
    expect(getFreshnessScore({ ...base, stale_files_count: 5, age_seconds: 100000 })).toBe(0.6);
  });
});

describe('getGraphStatus git portability', () => {
  const originalCacheHome = process.env.XDG_CACHE_HOME;
  let tempRoot: string | undefined;

  afterEach(() => {
    childProcessMocks.execFileSync.mockReset();
    if (originalCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = originalCacheHome;
    }
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('checks all commits since indexing and only bounds the returned sample', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'cbm-graph-status-'));
    const project = `portability-${Date.now()}`;
    const projectRoot = join(tempRoot, 'project');
    const cacheRoot = join(tempRoot, 'cache');
    process.env.XDG_CACHE_HOME = cacheRoot;

    mkdirSync(join(projectRoot, '.git'), { recursive: true });
    const dbDir = join(cacheRoot, 'codebase-memory-mcp');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, `${project}.db`), 'not-a-sqlite-database');

    const codePaths = Array.from(
      { length: 105 },
      (_, index) => `src/file-${String(index).padStart(3, '0')}.ts`
    );
    childProcessMocks.execFileSync.mockImplementation((_command, args: string[]) =>
      args[0] === 'log'
        ? ['src/file-000.ts', ...codePaths.toReversed(), '', 'docs/readme.md', ''].join('\r\n')
        : ''
    );

    const codeReader = {
      countNodes: () => 1,
      countEdges: () => 0,
      countNodesByLabel: () => ({}),
    } as unknown as CodeGraphReader;

    const status = getGraphStatus(project, codeReader, projectRoot);

    expect(childProcessMocks.execFileSync).toHaveBeenCalledTimes(2);
    expect(childProcessMocks.execFileSync).toHaveBeenNthCalledWith(
      1,
      'git',
      [
        'log',
        '--name-only',
        '--pretty=format:',
        expect.stringMatching(/^--since=@\d+$/),
        '--diff-filter=ACDMRTUXB',
      ],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
        shell: false,
      }
    );
    expect(childProcessMocks.execFileSync).toHaveBeenNthCalledWith(
      2,
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
        shell: false,
      },
    );
    expect(status.stale_files_count).toBe(105);
    expect(status.stale_files_sample).toEqual(codePaths.slice(0, 10));
  });

  it('detects post-index working-tree edits and indexed deletions', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'cbm-graph-status-dirty-'));
    const project = `dirty-${Date.now()}`;
    const projectRoot = join(tempRoot, 'project');
    const cacheRoot = join(tempRoot, 'cache');
    process.env.XDG_CACHE_HOME = cacheRoot;
    mkdirSync(join(projectRoot, '.git'), { recursive: true });
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    const dbDir = join(cacheRoot, 'codebase-memory-mcp');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = join(dbDir, `${project}.db`);
    writeFileSync(dbPath, 'not-a-sqlite-database');
    const dirtyPath = join(projectRoot, 'src', 'dirty.ts');
    writeFileSync(dirtyPath, 'export const dirty = true;\n');
    const future = new Date(Date.now() + 5_000);
    utimesSync(dirtyPath, future, future);

    childProcessMocks.execFileSync.mockImplementation((_command, args: string[]) =>
      args[0] === 'log' ? '' : ' M src/dirty.ts\0 D src/deleted.ts\0'
    );
    const codeReader = {
      countNodes: () => 2,
      countEdges: () => 0,
      countNodesByLabel: () => ({}),
      findNodesByFilePath: (_project: string, path: string) =>
        path === 'src/deleted.ts' ? [{ file_path: 'src\\deleted.ts' }] : [],
    } as unknown as CodeGraphReader;

    const status = getGraphStatus(project, codeReader, projectRoot);

    expect(status.stale_files_count).toBe(2);
    expect(status.stale_files_sample).toEqual(['src/deleted.ts', 'src/dirty.ts']);
    expect(status.stale).toBe(true);
  });

  it('fails closed when the bounded Git history query errors', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'cbm-graph-status-'));
    const project = `git-error-${Date.now()}`;
    const projectRoot = join(tempRoot, 'project');
    const cacheRoot = join(tempRoot, 'cache');
    process.env.XDG_CACHE_HOME = cacheRoot;

    mkdirSync(join(projectRoot, '.git'), { recursive: true });
    const dbDir = join(cacheRoot, 'codebase-memory-mcp');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, `${project}.db`), 'not-a-sqlite-database');

    childProcessMocks.execFileSync.mockImplementation(() => {
      throw new Error('stdout maxBuffer length exceeded');
    });

    const codeReader = {
      countNodes: () => 1,
      countEdges: () => 0,
      countNodesByLabel: () => ({}),
    } as unknown as CodeGraphReader;

    const status = getGraphStatus(project, codeReader, projectRoot);

    expect(status.stale).toBe(true);
    expect(status.stale_reason).toBe(
      'Unable to verify source changes since last index (Git history query failed)'
    );
    expect(status.recommendation).toContain('STALE:');
    expect(status.recommendation).not.toBe('FRESH');
  });
});

describe('freshnessLabel', () => {
  it('returns FRESH for score >= 0.9', () => {
    expect(freshnessLabel(0.9)).toBe('FRESH');
    expect(freshnessLabel(1.0)).toBe('FRESH');
  });

  it('returns RECENT for score >= 0.7', () => {
    expect(freshnessLabel(0.7)).toBe('RECENT');
    expect(freshnessLabel(0.85)).toBe('RECENT');
  });

  it('returns STALE for score >= 0.5', () => {
    expect(freshnessLabel(0.5)).toBe('STALE');
    expect(freshnessLabel(0.65)).toBe('STALE');
  });

  it('returns OLD for score >= 0.3', () => {
    expect(freshnessLabel(0.3)).toBe('OLD');
    expect(freshnessLabel(0.45)).toBe('OLD');
  });

  it('returns CRITICAL for score < 0.3', () => {
    expect(freshnessLabel(0.0)).toBe('CRITICAL');
    expect(freshnessLabel(0.2)).toBe('CRITICAL');
  });
});
