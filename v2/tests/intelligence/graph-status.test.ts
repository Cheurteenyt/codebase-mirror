// v2/tests/intelligence/graph-status.test.ts
// Tests for graph freshness detection.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getFreshnessScore, freshnessLabel } from '../../src/intelligence/graph-status.js';
import type { GraphStatus } from '../../src/intelligence/graph-status.js';

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
