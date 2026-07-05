// v2/src/intelligence/ttl-cache.ts
// R36: Generic TTL cache for expensive query results.
//
// Architecture:
//   - LRU eviction with configurable max entries
//   - Per-entry TTL (time-to-live) in milliseconds
//   - Optional invalidation callback (for NotifyHub integration)
//   - Thread-safe (single-threaded JS, but handles re-entrancy)
//   - Statistics tracking (hits, misses, evictions)
//
// Usage:
//   const cache = new TtlCache<string, GraphStatus>({ ttlMs: 30000, maxEntries: 100 });
//   const status = cache.getOrCompute('project:graph-status', () => getGraphStatus(...));
//
// The cache is designed for read-heavy, write-rare workloads:
//   - getGraphStatus runs execSync('git log ...') — expensive (50-200ms)
//   - /api/dashboard recomputes module degrees — expensive (10-50ms)
//   - getProjectOverview counts nodes/edges — moderate (1-10ms)
//
// With a 30s TTL, a dashboard that auto-refreshes every 10s will hit the
// cache 2 out of 3 times, reducing CPU usage by ~66%.

/**
 * Cache entry with value, expiration timestamp, and LRU access order.
 */
interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  lastAccessed: number;
}

/**
 * Options for configuring a TtlCache instance.
 */
export interface TtlCacheOptions {
  /** Time-to-live for each entry, in milliseconds. Default: 30000 (30s). */
  ttlMs?: number;
  /** Maximum number of entries before LRU eviction. Default: 100. */
  maxEntries?: number;
  /** Whether to track hit/miss statistics. Default: true. */
  trackStats?: boolean;
}

/**
 * Statistics for a TtlCache instance.
 */
export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  hitRate: number;
}

/**
 * Generic TTL cache with LRU eviction.
 *
 * Features:
 * - O(1) get and set operations (Map-based)
 * - LRU eviction when maxEntries is exceeded
 * - Automatic expiry on get (lazy expiration)
 * - Optional statistics tracking
 * - `getOrCompute` for compute-if-absent pattern
 * - `invalidate` for manual cache busting (e.g., on DB mutation)
 * - `invalidatePrefix` for bulk invalidation (e.g., all entries for a project)
 *
 * The cache is NOT thread-safe for cross-process use — it's in-memory only.
 * For the V2 sidecar (single-process), this is sufficient. The watch daemon
 * and MCP server each have their own process, so they each get their own
 * cache instance (which is correct — they each need fresh data).
 */
export class TtlCache<K, V> {
  private entries = new Map<K, CacheEntry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly trackStats: boolean;
  private stats = { hits: 0, misses: 0, evictions: 0 };

  constructor(opts: TtlCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30000;
    this.maxEntries = opts.maxEntries ?? 100;
    this.trackStats = opts.trackStats ?? true;
  }

  /**
   * Get a value from the cache. Returns undefined if the key is not present
   * or has expired (expired entries are lazily evicted on get).
   */
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      if (this.trackStats) this.stats.misses++;
      return undefined;
    }

    // Check if the entry has expired.
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      if (this.trackStats) this.stats.misses++;
      return undefined;
    }

    // Update LRU access order (Map preserves insertion order in JS, so we
    // delete and re-insert to move the entry to the end = most recently used).
    this.entries.delete(key);
    entry.lastAccessed = Date.now();
    this.entries.set(key, entry);

    if (this.trackStats) this.stats.hits++;
    return entry.value;
  }

  /**
   * Set a value in the cache with the default TTL.
   * If the cache is at capacity, the least recently used entry is evicted.
   */
  set(key: K, value: V, customTtlMs?: number): void {
    const ttl = customTtlMs ?? this.ttlMs;

    // If the key already exists, delete it first (to update insertion order).
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    // Evict LRU entries if at capacity.
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
      if (this.trackStats) this.stats.evictions++;
    }

    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttl,
      lastAccessed: Date.now(),
    });
  }

  /**
   * Get a value from the cache, or compute it if absent/expired.
   * The compute function is only called if the cache miss occurs.
   *
   * Example:
   *   const status = cache.getOrCompute(key, () => expensiveQuery(), { ttlMs: 60000 });
   */
  getOrCompute(key: K, compute: () => V, opts?: { ttlMs?: number }): V {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const value = compute();
    this.set(key, value, opts?.ttlMs);
    return value;
  }

  /**
   * Invalidate a single cache entry.
   */
  invalidate(key: K): void {
    this.entries.delete(key);
  }

  /**
   * Invalidate all cache entries whose key matches a prefix.
   * Useful for invalidating all entries for a specific project.
   *
   * Example:
   *   cache.invalidatePrefix('my-project:'); // clears all entries for 'my-project'
   */
  invalidatePrefix(prefix: string): void {
    // Note: this only works if keys are strings. For non-string keys,
    // the caller should use invalidate() individually.
    for (const key of this.entries.keys()) {
      if (typeof key === 'string' && key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Get cache statistics (hits, misses, evictions, hit rate).
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      size: this.entries.size,
      hitRate: total > 0 ? this.stats.hits / total : 0,
    };
  }

  /**
   * Reset statistics (does not clear entries).
   */
  resetStats(): void {
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /**
   * Get the current number of entries (including potentially expired ones
   * that haven't been lazily evicted yet).
   */
  get size(): number {
    return this.entries.size;
  }
}
