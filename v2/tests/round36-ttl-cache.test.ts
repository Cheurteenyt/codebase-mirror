// v2/tests/round36-ttl-cache.test.ts
// R36: Tests for the TtlCache and its integration with getGraphStatus.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TtlCache } from '../src/intelligence/ttl-cache.js';
import { invalidateGraphStatusCache, getGraphStatusCacheStats } from '../src/intelligence/graph-status.js';

describe('R36: TtlCache', () => {
  let cache: TtlCache<string, number>;

  beforeEach(() => {
    cache = new TtlCache({ ttlMs: 100, maxEntries: 5 });
  });

  it('returns undefined for missing keys', () => {
    expect(cache.get('missing')).toBeUndefined();
  });

  it('stores and retrieves values', () => {
    cache.set('key1', 42);
    expect(cache.get('key1')).toBe(42);
  });

  it('expires entries after TTL', () => {
    cache.set('key1', 42);
    // Wait 150ms (TTL is 100ms).
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(cache.get('key1')).toBeUndefined();
        resolve(void 0);
      }, 150);
    });
  });

  it('getOrCompute computes on cache miss', () => {
    let computeCount = 0;
    const result = cache.getOrCompute('key1', () => {
      computeCount++;
      return 99;
    });
    expect(result).toBe(99);
    expect(computeCount).toBe(1);
  });

  it('getOrCompute uses cache on hit (does not recompute)', () => {
    let computeCount = 0;
    cache.getOrCompute('key1', () => { computeCount++; return 99; });
    const result = cache.getOrCompute('key1', () => { computeCount++; return 100; });
    expect(result).toBe(99); // cached value, not recomputed
    expect(computeCount).toBe(1);
  });

  it('evicts LRU entries when maxEntries is exceeded', () => {
    cache.set('k1', 1);
    cache.set('k2', 2);
    cache.set('k3', 3);
    cache.set('k4', 4);
    cache.set('k5', 5);
    // Access k1 to make it most recently used.
    cache.get('k1');
    // Add k6 — should evict k2 (least recently used).
    cache.set('k6', 6);
    expect(cache.get('k1')).toBe(1); // still present (was accessed)
    expect(cache.get('k2')).toBeUndefined(); // evicted (LRU)
    expect(cache.get('k6')).toBe(6); // newly added
  });

  it('invalidate removes a specific key', () => {
    cache.set('key1', 42);
    cache.invalidate('key1');
    expect(cache.get('key1')).toBeUndefined();
  });

  it('invalidatePrefix removes all matching keys', () => {
    cache.set('project1:status', 1);
    cache.set('project1:dashboard', 2);
    cache.set('project2:status', 3);
    cache.invalidatePrefix('project1:');
    expect(cache.get('project1:status')).toBeUndefined();
    expect(cache.get('project1:dashboard')).toBeUndefined();
    expect(cache.get('project2:status')).toBe(3); // not affected
  });

  it('clear removes all entries', () => {
    cache.set('k1', 1);
    cache.set('k2', 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('tracks hit/miss statistics', () => {
    cache.set('k1', 42);
    cache.get('k1'); // hit
    cache.get('k1'); // hit
    cache.get('missing'); // miss
    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3, 2);
  });

  it('resetStats resets counters without clearing entries', () => {
    cache.set('k1', 42);
    cache.get('k1'); // hit
    cache.resetStats();
    const stats = cache.getStats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.size).toBe(1); // entry still present
    expect(cache.get('k1')).toBe(42); // still works
  });

  it('supports custom TTL per entry', () => {
    cache.set('short', 1, 50); // 50ms TTL
    cache.set('long', 2, 5000); // 5s TTL
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(cache.get('short')).toBeUndefined(); // expired
        expect(cache.get('long')).toBe(2); // still valid
        resolve(void 0);
      }, 100);
    });
  });
});

describe('R36: getGraphStatus cache integration', () => {
  it('invalidateGraphStatusCache does not throw', () => {
    expect(() => invalidateGraphStatusCache('test-project')).not.toThrow();
  });

  it('getGraphStatusCacheStats returns stats object with SWR fields', () => {
    const stats = getGraphStatusCacheStats();
    expect(stats).toBeDefined();
    // R37: SwrCache uses freshHits/staleHits instead of hits.
    expect(typeof stats.freshHits).toBe('number');
    expect(typeof stats.staleHits).toBe('number');
    expect(typeof stats.misses).toBe('number');
    expect(typeof stats.backgroundRefreshes).toBe('number');
    expect(typeof stats.size).toBe('number');
    expect(typeof stats.bytesUsed).toBe('number');
    expect(typeof stats.hitRate).toBe('number');
    expect(typeof stats.staleRate).toBe('number');
  });
});
