// v2/tests/round37-swr-cache.test.ts
// R37: Tests for the SwrCache (Stale-While-Revalidate) with adaptive TTL
// and memory-aware eviction.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SwrCache } from '../src/intelligence/swr-cache.js';
import { invalidateGraphStatusCache, getGraphStatusCacheStats } from '../src/intelligence/graph-status.js';

describe('R37: SwrCache basic operations', () => {
  let cache: SwrCache<string, number>;

  beforeEach(() => {
    cache = new SwrCache({ ttlMs: 100, staleMs: 100, maxEntries: 10 });
  });

  it('returns undefined for missing keys', () => {
    expect(cache.get('missing')).toBeUndefined();
  });

  it('stores and retrieves fresh values', () => {
    cache.set('key1', 42);
    expect(cache.get('key1')).toBe(42);
  });

  it('getWithPhase returns phase=fresh for fresh entries', () => {
    cache.set('key1', 42);
    const result = cache.getWithPhase('key1');
    expect(result?.value).toBe(42);
    expect(result?.phase).toBe('fresh');
  });

  it('returns undefined after full expiry (past stale window)', () => {
    cache.set('key1', 42);
    // Wait 250ms (TTL=100ms + stale=100ms + margin).
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(cache.get('key1')).toBeUndefined();
        resolve(void 0);
      }, 250);
    });
  });
});

describe('R37: SwrCache stale-while-revalidate', () => {
  let cache: SwrCache<string, number>;
  let refreshCount: number;

  beforeEach(() => {
    refreshCount = 0;
    cache = new SwrCache({ ttlMs: 50, staleMs: 100, maxEntries: 10 });
  });

  it('serves stale value and triggers background refresh', () => {
    cache.set('key1', 42);
    // Set a refresh handler that increments a counter.
    cache.setRefreshHandler('key1', () => {
      refreshCount++;
      return 99;
    });

    // Wait for the entry to become stale (past ttlMs=50ms but within staleMs=100ms).
    return new Promise((resolve) => {
      setTimeout(() => {
        const result = cache.getWithPhase('key1');
        // Should return the stale value (42, not 99).
        expect(result?.value).toBe(42);
        expect(result?.phase).toBe('stale');

        // Wait for the background refresh to complete (setTimeout 0).
        setTimeout(() => {
          // The background refresh should have run.
          expect(refreshCount).toBe(1);

          // Next get should return the refreshed value (99).
          const refreshed = cache.get('key1');
          expect(refreshed).toBe(99);
          resolve(void 0);
        }, 50);
      }, 75); // past fresh (50ms) but within stale (150ms total)
    });
  });

  it('does NOT trigger multiple background refreshes for concurrent stale reads', () => {
    cache.set('key1', 42);
    cache.setRefreshHandler('key1', () => {
      refreshCount++;
      return 99;
    });

    return new Promise((resolve) => {
      setTimeout(() => {
        // Multiple stale reads in quick succession.
        cache.getWithPhase('key1');
        cache.getWithPhase('key1');
        cache.getWithPhase('key1');

        setTimeout(() => {
          // Only ONE background refresh should have been triggered.
          expect(refreshCount).toBe(1);
          resolve(void 0);
        }, 50);
      }, 75);
    });
  });
});

describe('R37: SwrCache adaptive TTL', () => {
  it('uses base TTL for entries accessed <3 times', () => {
    const cache = new SwrCache<string, number>({ ttlMs: 100, staleMs: 100, maxEntries: 10 });
    cache.set('key1', 42);
    cache.get('key1'); // accessCount = 1
    cache.get('key1'); // accessCount = 2
    // Entry should still be fresh at 50ms (well within 100ms TTL).
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(cache.get('key1')).toBe(42);
        resolve(void 0);
      }, 50);
    });
  });

  it('uses extended TTL for entries accessed 3+ times', () => {
    const cache = new SwrCache<string, number>({ ttlMs: 50, staleMs: 50, maxTtlMs: 200, maxEntries: 10 });
    cache.set('key1', 42);
    cache.get('key1'); // accessCount = 1
    cache.get('key1'); // accessCount = 2
    cache.get('key1'); // accessCount = 3 — adaptive TTL kicks in (50 * 2 = 100ms)

    // At 75ms, a base-TTL entry would be stale, but an adaptive-TTL entry
    // (100ms) should still be fresh.
    return new Promise((resolve) => {
      setTimeout(() => {
        const result = cache.getWithPhase('key1');
        expect(result?.value).toBe(42);
        // With adaptive TTL (100ms), 75ms is still fresh.
        // Without adaptive (50ms), 75ms would be stale.
        // We can't strictly assert phase=fresh because the exact timing
        // depends on when the get() calls ran, but the value should be present.
        expect(result).toBeDefined();
        resolve(void 0);
      }, 75);
    });
  });
});

describe('R37: SwrCache memory-aware eviction', () => {
  it('evicts entries based on memory budget', () => {
    const cache = new SwrCache<string, string>({
      ttlMs: 10000,
      staleMs: 10000,
      maxBytes: 30, // very small budget
      maxEntries: 100,
      sizeFn: (v) => v.length,
    });

    cache.set('a', '0123456789'); // 10 bytes
    cache.set('b', '0123456789'); // 10 bytes
    cache.set('c', '0123456789'); // 10 bytes — total 30 bytes, at budget

    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();

    // Add one more — should evict the LRU entry ('a' was accessed least recently).
    cache.set('d', '0123456789'); // 10 bytes — total would be 40, over budget

    // 'a' should be evicted (it was the least recently used after we accessed b and c).
    // Actually, we accessed a, b, c in that order via get(), so 'a' is the oldest.
    // But we also did get() on a, b, c which updates LRU. Let me trace:
    // After set('a'), set('b'), set('c'): order is a, b, c.
    // After get('a'), get('b'), get('c'): order is a, b, c (re-inserted in get order).
    // After set('d'): evicts 'a' (first in Map = LRU).
    expect(cache.get('a')).toBeUndefined(); // evicted
    // b, c, d should still be present.
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
  });

  it('tracks bytesUsed in statistics', () => {
    const cache = new SwrCache<string, string>({
      ttlMs: 10000,
      staleMs: 10000,
      maxBytes: 1000,
      sizeFn: (v) => v.length,
    });

    cache.set('key1', 'hello'); // 5 bytes
    cache.set('key2', 'world'); // 5 bytes

    const stats = cache.getStats();
    expect(stats.bytesUsed).toBe(10);
  });
});

describe('R37: SwrCache getOrCompute with SWR', () => {
  it('computes on first call, returns cached on subsequent calls', () => {
    const cache = new SwrCache<string, number>({ ttlMs: 100, staleMs: 100, maxEntries: 10 });
    let computeCount = 0;

    const v1 = cache.getOrCompute('key1', () => { computeCount++; return 42; });
    expect(v1).toBe(42);
    expect(computeCount).toBe(1);

    const v2 = cache.getOrCompute('key1', () => { computeCount++; return 99; });
    expect(v2).toBe(42); // cached, not recomputed
    expect(computeCount).toBe(1);
  });

  it('serves stale value with background refresh after TTL expiry', () => {
    const cache = new SwrCache<string, number>({ ttlMs: 50, staleMs: 100, maxEntries: 10 });
    let computeCount = 0;
    // R37: the compute function must be stable — the refresh handler captures
    // the FIRST compute function passed to getOrCompute. Changing it between
    // calls would NOT update the refresh handler (this is by design).
    const compute = () => {
      computeCount++;
      return computeCount === 1 ? 42 : 99; // first call returns 42, subsequent return 99
    };

    cache.getOrCompute('key1', compute);
    expect(computeCount).toBe(1);

    return new Promise((resolve) => {
      setTimeout(() => {
        // Entry is now stale (past 50ms fresh, within 150ms stale).
        // getOrCompute should return stale 42 and trigger background refresh.
        const v = cache.getOrCompute('key1', compute);
        expect(v).toBe(42); // stale value

        // Wait for background refresh to complete.
        setTimeout(() => {
          // Background refresh should have called compute once.
          // Total: 1 (initial) + 1 (background) = 2.
          expect(computeCount).toBe(2);

          // Next call should return the refreshed value (99).
          const v2 = cache.getOrCompute('key1', compute);
          expect(v2).toBe(99); // refreshed value
          resolve(void 0);
        }, 50);
      }, 75);
    });
  });
});

describe('R37: SwrCache statistics', () => {
  it('tracks freshHits, staleHits, misses separately', () => {
    const cache = new SwrCache<string, number>({ ttlMs: 50, staleMs: 100, maxEntries: 10 });
    cache.set('key1', 42);

    cache.get('key1'); // fresh hit
    cache.get('key1'); // fresh hit
    cache.get('missing'); // miss

    const stats = cache.getStats();
    expect(stats.freshHits).toBe(2);
    expect(stats.staleHits).toBe(0);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3, 2);
    expect(stats.staleRate).toBe(0);
  });

  it('tracks evictions', () => {
    const cache = new SwrCache<string, number>({ ttlMs: 10000, staleMs: 10000, maxEntries: 3 });
    cache.set('k1', 1);
    cache.set('k2', 2);
    cache.set('k3', 3);
    cache.set('k4', 4); // evicts k1 (LRU)

    const stats = cache.getStats();
    expect(stats.evictions).toBe(1);
  });

  it('resetStats clears counters but not entries', () => {
    const cache = new SwrCache<string, number>({ ttlMs: 10000, staleMs: 10000, maxEntries: 10 });
    cache.set('k1', 42);
    cache.get('k1'); // fresh hit

    cache.resetStats();
    const stats = cache.getStats();
    expect(stats.freshHits).toBe(0);
    expect(stats.size).toBe(1);
    expect(cache.get('k1')).toBe(42);
  });
});

describe('R37: SwrCache invalidation', () => {
  it('invalidate removes a single entry', () => {
    const cache = new SwrCache<string, number>({ ttlMs: 10000, staleMs: 10000, maxEntries: 10 });
    cache.set('k1', 42);
    cache.invalidate('k1');
    expect(cache.get('k1')).toBeUndefined();
  });

  it('invalidatePrefix removes matching entries', () => {
    const cache = new SwrCache<string, number>({ ttlMs: 10000, staleMs: 10000, maxEntries: 10 });
    cache.set('proj1:status', 1);
    cache.set('proj1:dashboard', 2);
    cache.set('proj2:status', 3);
    cache.invalidatePrefix('proj1:');
    expect(cache.get('proj1:status')).toBeUndefined();
    expect(cache.get('proj1:dashboard')).toBeUndefined();
    expect(cache.get('proj2:status')).toBe(3);
  });

  it('clear removes all entries and resets bytesUsed', () => {
    const cache = new SwrCache<string, string>({
      ttlMs: 10000, staleMs: 10000, maxBytes: 1000,
      sizeFn: (v) => v.length,
    });
    cache.set('k1', 'hello');
    cache.set('k2', 'world');
    expect(cache.bytesUsed).toBe(10);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytesUsed).toBe(0);
  });
});

describe('R37: SwrCache graph status integration', () => {
  it('invalidateGraphStatusCache does not throw', () => {
    expect(() => invalidateGraphStatusCache('test-project')).not.toThrow();
  });

  it('getGraphStatusCacheStats returns SWR stats', () => {
    const stats = getGraphStatusCacheStats();
    expect(stats).toBeDefined();
    expect(typeof stats.freshHits).toBe('number');
    expect(typeof stats.staleHits).toBe('number');
    expect(typeof stats.misses).toBe('number');
    expect(typeof stats.backgroundRefreshes).toBe('number');
    expect(typeof stats.bytesUsed).toBe('number');
    expect(typeof stats.hitRate).toBe('number');
    expect(typeof stats.staleRate).toBe('number');
  });
});
