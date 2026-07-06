// v2/src/intelligence/swr-cache.ts
// R37: Stale-While-Revalidate (SWR) cache — production-grade caching with
// background refresh, adaptive TTL, and memory-aware eviction.
//
// This is a significant evolution of the R36 TtlCache. The key insight is
// that for getGraphStatus (50-200ms via execSync), a slightly stale result
// (30s old) is perfectly acceptable. The SWR pattern eliminates the latency
// spike that occurs on cache expiry by returning the stale value immediately
// and refreshing in the background.
//
// ── Two-phase TTL ──
//
//   fresh ──────────────── stale ──────────────── expired
//   (0 to ttlMs)          (ttlMs to staleMs)      (after staleMs)
//   │                     │                        │
//   │ return immediately  │ return stale +         │ cache miss:
//   │ (0ms)               │ trigger background     │ compute synchronously
//   │                     │ refresh (0ms return)   │ (50-200ms)
//
// Example with ttlMs=30s, staleMs=60s:
//   t=0s:   compute (200ms) → cache as fresh
//   t=10s:  fresh hit (0ms)
//   t=20s:  fresh hit (0ms)
//   t=31s:  stale hit (0ms) → trigger background refresh
//   t=31s:  background refresh runs (200ms) → cache as fresh again
//   t=40s:  fresh hit (0ms)
//
// Without SWR, t=31s would be a 200ms blocking call. With SWR, it's 0ms.
//
// ── Adaptive TTL ──
//
// Entries that are accessed frequently get longer TTLs, reducing the
// frequency of expensive recomputations. Entries that are rarely accessed
// get shorter TTLs, freeing memory sooner.
//
//   accessCount < 3:   TTL = baseTtl (30s)
//   accessCount 3-9:   TTL = baseTtl * 2 (60s)
//   accessCount 10+:   TTL = baseTtl * 4 (120s, capped at maxTtl)
//
// ── Memory-aware eviction ──
//
// Instead of just counting entries (maxEntries), the cache tracks an
// approximate memory footprint. When the budget is exceeded, the least
// recently used entries are evicted first. The size is estimated via
// an optional `sizeFn(value)` — if not provided, each entry counts as 1.
//
// ── Background refresh ──
//
// When a stale entry is served, a background refresh is scheduled via
// `setTimeout(0)`. This defers the computation to the next event loop
// tick, so the current caller returns immediately with the stale value.
// If a second caller arrives while the refresh is in-flight, it also
// gets the stale value (the refresh is not duplicated).
//
// IMPORTANT: because better-sqlite3 is synchronous, the "background"
// refresh will still block the event loop when it runs. The benefit is
// that the CURRENT caller doesn't wait — only future callers pay the
// cost, and by then the cache is fresh again.

import { EventEmitter } from 'node:events';

/**
 * Phase of a cache entry's lifecycle.
 */
export type CachePhase = 'fresh' | 'stale' | 'expired';

/**
 * Internal cache entry with two-phase TTL and adaptive metadata.
 */
interface SwrCacheEntry<V> {
  value: V;
  /** When the entry transitions from fresh to stale. */
  freshUntil: number;
  /** When the entry transitions from stale to expired (must evict). */
  staleUntil: number;
  /** Adaptive TTL: the current effective TTL for this entry. */
  currentTtl: number;
  /** Number of times this entry has been accessed (for adaptive TTL). */
  accessCount: number;
  /** Whether a background refresh is currently in-flight. */
  refreshing: boolean;
  /** Approximate size of the value (for memory-aware eviction). */
  size: number;
}

/**
 * Options for configuring an SwrCache instance.
 */
export interface SwrCacheOptions<V = unknown> {
  /** Fresh TTL: how long the value is considered fresh. Default: 30000 (30s). */
  ttlMs?: number;
  /**
   * Stale window: how long the value is served as stale (with background refresh)
   * before being evicted. Default: 30000 (30s). Total cache lifetime = ttlMs + staleMs.
   */
  staleMs?: number;
  /**
   * Maximum TTL after adaptive scaling. Default: 120000 (2min).
   * Frequently accessed entries get longer TTLs, capped at this value.
   */
  maxTtlMs?: number;
  /**
   * Memory budget in approximate bytes. When exceeded, LRU entries are evicted.
   * Default: 1_000_000 (1MB). Set to 0 to disable memory-aware eviction
   * and use maxEntries instead.
   */
  maxBytes?: number;
  /**
   * Maximum number of entries (fallback when maxBytes is 0 or sizeFn is not provided).
   * Default: 100.
   */
  maxEntries?: number;
  /**
   * Optional function to estimate the size of a cached value.
   * If not provided, each entry counts as 1 (count-based eviction).
   * Example: (v) => JSON.stringify(v).length
   */
  sizeFn?: (value: V) => number;
  /** Whether to track detailed statistics. Default: true. */
  trackStats?: boolean;
}

/**
 * Comprehensive statistics for an SwrCache instance.
 */
export interface SwrCacheStats {
  /** Fresh cache hits (value served from cache, still fresh). */
  freshHits: number;
  /** Stale cache hits (stale value served, background refresh triggered). */
  staleHits: number;
  /** Cache misses (value not in cache or fully expired, computed synchronously). */
  misses: number;
  /** Number of background refreshes triggered. */
  backgroundRefreshes: number;
  /** Number of entries evicted due to memory/entry pressure. */
  evictions: number;
  /** Current number of entries in the cache. */
  size: number;
  /** Approximate memory usage in bytes (or entry count if sizeFn not provided). */
  bytesUsed: number;
  /** Overall hit rate (freshHits + staleHits) / (freshHits + staleHits + misses). */
  hitRate: number;
  /** Fraction of hits that were stale (served from stale window). */
  staleRate: number;
}

/**
 * Stale-While-Revalidate cache with adaptive TTL and memory-aware eviction.
 *
 * This cache is designed for read-heavy workloads where:
 * - The compute function is expensive (50-200ms)
 * - Slightly stale results are acceptable (30-60s old)
 * - Multiple callers may request the same key within a short window
 *
 * The SWR pattern eliminates latency spikes on cache expiry:
 *   - Fresh hits: 0ms (instant return)
 *   - Stale hits: 0ms (instant return + background refresh)
 *   - Misses: 50-200ms (synchronous compute)
 *
 * Without SWR, every cache expiry would cause a 50-200ms spike. With SWR,
 * the spike is deferred to the background, and the next caller gets a fresh hit.
 */
export class SwrCache<K, V> {
  private entries = new Map<K, SwrCacheEntry<V>>();
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly maxTtlMs: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly sizeFn: ((value: V) => number) | null;
  private readonly trackStats: boolean;
  private totalBytes = 0;
  private stats = {
    freshHits: 0,
    staleHits: 0,
    misses: 0,
    backgroundRefreshes: 0,
    evictions: 0,
  };

  // R37: optional event emitter for cache events (useful for debugging/monitoring).
  private readonly events = new EventEmitter();

  constructor(opts: SwrCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30000;
    this.staleMs = opts.staleMs ?? 30000;
    this.maxTtlMs = opts.maxTtlMs ?? 120000;
    this.maxBytes = opts.maxBytes ?? 1_000_000;
    this.maxEntries = opts.maxEntries ?? 100;
    this.sizeFn = opts.sizeFn ?? null;
    this.trackStats = opts.trackStats ?? true;
  }

  /**
   * Determine the current phase of a cache entry.
   */
  private getPhase(entry: SwrCacheEntry<V>): CachePhase {
    const now = Date.now();
    if (now < entry.freshUntil) return 'fresh';
    if (now < entry.staleUntil) return 'stale';
    return 'expired';
  }

  /**
   * Compute the adaptive TTL for an entry based on its access count.
   *
   *   accessCount < 3:   base TTL
   *   accessCount 3-9:   base TTL * 2
   *   accessCount 10+:   base TTL * 4 (capped at maxTtlMs)
   */
  private computeAdaptiveTtl(accessCount: number): number {
    if (accessCount < 3) return this.ttlMs;
    if (accessCount < 10) return Math.min(this.ttlMs * 2, this.maxTtlMs);
    return Math.min(this.ttlMs * 4, this.maxTtlMs);
  }

  /**
   * Estimate the size of a value using the configured sizeFn.
   * If no sizeFn is provided, returns 1 (count-based).
   */
  private estimateSize(value: V): number {
    if (this.sizeFn) {
      try {
        return this.sizeFn(value);
      } catch {
        return 1; // fallback if sizeFn throws
      }
    }
    return 1;
  }

  /**
   * Evict entries until the cache is within its memory/entry budget.
   * Uses LRU order (Map insertion order = access order in JS).
   */
  private evictToFit(): void {
    // Check memory budget.
    while (this.totalBytes > this.maxBytes && this.entries.size > 1) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const entry = this.entries.get(oldestKey);
      if (entry) this.totalBytes -= entry.size;
      this.entries.delete(oldestKey);
      if (this.trackStats) this.stats.evictions++;
    }

    // Check entry count budget (fallback when maxBytes is 0 or sizeFn not provided).
    const effectiveMaxEntries = this.maxBytes > 0 ? this.maxEntries : this.maxEntries;
    // R37 fix: use > instead of >= to allow exactly maxEntries entries.
    // With >=, setting the Nth entry would evict the (N-1)th, leaving only N-1 entries.
    while (this.entries.size > effectiveMaxEntries && this.entries.size > 1) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const entry = this.entries.get(oldestKey);
      if (entry) this.totalBytes -= entry.size;
      this.entries.delete(oldestKey);
      if (this.trackStats) this.stats.evictions++;
    }
  }

  /**
   * Get a value from the cache.
   *
   * Returns { value, phase } where phase indicates whether the value was
   * fresh, stale, or computed on-the-fly. Use `get()` for a simpler API
   * that returns just the value.
   *
   * For stale entries, a background refresh is triggered (if not already
   * in-flight). The stale value is returned immediately.
   */
  getWithPhase(key: K): { value: V; phase: CachePhase } | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      if (this.trackStats) this.stats.misses++;
      return undefined;
    }

    const phase = this.getPhase(entry);

    if (phase === 'expired') {
      // Remove expired entry.
      this.totalBytes -= entry.size;
      this.entries.delete(key);
      if (this.trackStats) this.stats.misses++;
      return undefined;
    }

    // Update LRU access order.
    this.entries.delete(key);
    entry.accessCount++;
    this.entries.set(key, entry);

    if (phase === 'fresh') {
      if (this.trackStats) this.stats.freshHits++;
    } else {
      // Stale: trigger background refresh if not already in-flight.
      if (this.trackStats) this.stats.staleHits++;
      if (!entry.refreshing) {
        entry.refreshing = true;
        this.scheduleBackgroundRefresh(key);
      }
    }

    return { value: entry.value, phase };
  }

  /**
   * Get a value from the cache. Returns undefined on miss (not in cache or
   * fully expired). For stale entries, the stale value is returned and a
   * background refresh is triggered.
   *
   * This is the simple API. Use `getWithPhase()` if you need to know
   * whether the value was fresh or stale.
   */
  get(key: K): V | undefined {
    const result = this.getWithPhase(key);
    return result?.value;
  }

  /**
   * Schedule a background refresh for a cache entry.
   *
   * The refresh runs on the next event loop tick via setTimeout(0).
   * This ensures the current caller returns immediately with the stale value.
   * The refresh callback must be set via `setRefreshHandler()`.
   */
  // R40 (L5): store opts alongside the handler so background refreshes honor
  // the caller's custom ttlMs/staleMs instead of degrading to the cache's
  // defaults after the first refresh. The previous code discarded opts, so
  // a caller passing { ttlMs: 60000 } would see their initial entry live for
  // 60s but the refreshed entry live for only 30s (the default).
  private refreshHandlers = new Map<K, { handler: () => V; opts?: { ttlMs?: number; staleMs?: number } }>();
  // R47 (L1): track pending refresh timers so invalidate/clear can cancel
  // them. Without this, a refresh scheduled before invalidate fires after
  // invalidate, re-inserting the just-invalidated value.
  private refreshTimers = new Map<K, ReturnType<typeof setTimeout>>();

  private scheduleBackgroundRefresh(key: K): void {
    // Cancel any previously-scheduled refresh for this key (dedup).
    const existing = this.refreshTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.refreshTimers.delete(key);
      const entry = this.entries.get(key);
      if (!entry) return; // entry was evicted/invalidated before refresh ran

      const handlerEntry = this.refreshHandlers.get(key);
      if (handlerEntry) {
        try {
          const newValue = handlerEntry.handler();
          // Update the entry with the fresh value.
          // R40 (L5): honor the caller's opts.ttlMs (with adaptive fallback)
          // and opts.staleMs (with cache default fallback) instead of always
          // using the cache-wide defaults.
          const opts = handlerEntry.opts;
          const newTtl = opts?.ttlMs ?? this.computeAdaptiveTtl(entry.accessCount);
          const newStale = opts?.staleMs ?? this.staleMs;
          const newSize = this.estimateSize(newValue);
          this.totalBytes -= entry.size;
          entry.value = newValue;
          entry.size = newSize;
          this.totalBytes += newSize;
          entry.freshUntil = Date.now() + newTtl;
          entry.staleUntil = entry.freshUntil + newStale;
          entry.currentTtl = newTtl;
          entry.refreshing = false;
          if (this.trackStats) this.stats.backgroundRefreshes++;
          this.events.emit('refresh', { key, phase: 'success' });
        } catch (e: any) {
          // Refresh failed — keep the stale value, mark as not refreshing.
          entry.refreshing = false;
          this.events.emit('refresh', { key, phase: 'error', error: e.message });
        }
      } else {
        // No handler — mark as not refreshing so the next stale hit can retry.
        entry.refreshing = false;
      }
    }, 0);
    this.refreshTimers.set(key, timer);
  }

  /**
   * Set a value in the cache with the default TTL.
   * If a refresh handler was previously set for this key, it is preserved.
   */
  set(key: K, value: V, opts?: { ttlMs?: number; staleMs?: number }): void {
    // R48 (#5): cancel any pending background refresh timer for this key.
    // Without this, a set() while a refresh is pending would let the old
    // handler overwrite the new value when the timer fires.
    const existingTimer = this.refreshTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.refreshTimers.delete(key);
    }

    const ttl = opts?.ttlMs ?? this.ttlMs;
    const stale = opts?.staleMs ?? this.staleMs;
    const now = Date.now();

    // If the key already exists, update it.
    const existing = this.entries.get(key);
    if (existing) {
      this.totalBytes -= existing.size;
      this.entries.delete(key);
    }

    const size = this.estimateSize(value);
    const entry: SwrCacheEntry<V> = {
      value,
      freshUntil: now + ttl,
      staleUntil: now + ttl + stale,
      currentTtl: ttl,
      accessCount: existing?.accessCount ?? 0,
      refreshing: false,
      size,
    };

    this.entries.set(key, entry);
    this.totalBytes += size;

    // Evict if over budget.
    this.evictToFit();
  }

  /**
   * Set a refresh handler for a key. The handler will be called in the
   * background when the entry transitions from fresh to stale.
   *
   * R40 (L5): opts (ttlMs, staleMs) are stored alongside the handler and used
   * by scheduleBackgroundRefresh. Without this, a caller passing custom opts
   * to getOrCompute would see them honored on the initial set but silently
   * downgraded to the cache defaults after the first background refresh.
   *
   * Example:
   *   cache.set('project:status', expensiveCompute(), { ttlMs: 60000 });
   *   cache.setRefreshHandler('project:status', () => expensiveCompute(), { ttlMs: 60000 });
   *   // Now, when the entry goes stale, the cache will automatically
   *   // refresh it in the background, preserving the 60s TTL.
   */
  setRefreshHandler(key: K, handler: () => V, opts?: { ttlMs?: number; staleMs?: number }): void {
    this.refreshHandlers.set(key, { handler, opts });
  }

  /**
   * Get a value from the cache, or compute it if absent/expired.
   * Also sets a refresh handler so future stale hits trigger background refresh.
   *
   * This is the main entry point for the SWR pattern:
   *   const value = cache.getOrCompute(key, () => expensiveQuery());
   *
   * On first call: computes synchronously, caches the result.
   * On subsequent fresh calls: returns cached value (0ms).
   * On stale calls: returns stale value (0ms) + triggers background refresh.
   * On expired/missing calls: computes synchronously again.
   */
  getOrCompute(key: K, compute: () => V, opts?: { ttlMs?: number; staleMs?: number }): V {
    const result = this.getWithPhase(key);
    if (result !== undefined) {
      // Cache hit (fresh or stale). Ensure refresh handler is set for future stale hits.
      // R40 (L5): pass opts so future background refreshes honor the caller's TTL.
      if (!this.refreshHandlers.has(key)) {
        this.setRefreshHandler(key, compute, opts);
      }
      return result.value;
    }

    // Cache miss: compute synchronously.
    const value = compute();
    this.set(key, value, opts);
    // Set refresh handler for future background refreshes.
    // R40 (L5): pass opts so future background refreshes honor the caller's TTL.
    this.setRefreshHandler(key, compute, opts);
    return value;
  }

  /**
   * Invalidate a single cache entry.
   */
  invalidate(key: K): void {
    // R47 (L1): cancel any pending background refresh for this key so it
    // doesn't re-insert the value we're about to evict.
    const timer = this.refreshTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.refreshTimers.delete(key);
    }
    const entry = this.entries.get(key);
    if (entry) {
      this.totalBytes -= entry.size;
      this.entries.delete(key);
    }
    this.refreshHandlers.delete(key);
  }

  /**
   * Invalidate all cache entries whose key matches a prefix.
   * Useful for invalidating all entries for a specific project.
   */
  invalidatePrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (typeof key === 'string' && key.startsWith(prefix)) {
        this.invalidate(key);
      }
    }
  }

  /**
   * Clear all cache entries and refresh handlers.
   */
  clear(): void {
    // R47 (L1): cancel all pending refresh timers.
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    this.entries.clear();
    this.refreshHandlers.clear();
    this.totalBytes = 0;
  }

  /**
   * Get comprehensive cache statistics.
   */
  getStats(): SwrCacheStats {
    const totalHits = this.stats.freshHits + this.stats.staleHits;
    const totalRequests = totalHits + this.stats.misses;
    return {
      freshHits: this.stats.freshHits,
      staleHits: this.stats.staleHits,
      misses: this.stats.misses,
      backgroundRefreshes: this.stats.backgroundRefreshes,
      evictions: this.stats.evictions,
      size: this.entries.size,
      bytesUsed: this.totalBytes,
      hitRate: totalRequests > 0 ? totalHits / totalRequests : 0,
      staleRate: totalHits > 0 ? this.stats.staleHits / totalHits : 0,
    };
  }

  /**
   * Reset statistics (does not clear entries).
   */
  resetStats(): void {
    this.stats = {
      freshHits: 0,
      staleHits: 0,
      misses: 0,
      backgroundRefreshes: 0,
      evictions: 0,
    };
  }

  /**
   * Get the current number of entries.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Get approximate memory usage (or entry count if sizeFn not provided).
   */
  get bytesUsed(): number {
    return this.totalBytes;
  }

  /**
   * Subscribe to cache events. Available events:
   * - 'refresh': emitted when a background refresh completes (success or error).
   *
   * Example:
   *   cache.on('refresh', ({ key, phase, error }) => {
   *     console.log(`Cache refresh ${phase} for key: ${key}`);
   *   });
   */
  on(event: string, listener: (...args: any[]) => void): () => void {
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }
}
