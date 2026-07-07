# V1 C Engine — Audit Report (Reference, Read-Only)

> **V1 is kept intact as a reference for comparison with V2.**
> This audit documents findings without modifying V1 code.
> Created as part of R65 (2026-07-07).

## Scope

V1 C engine: 65,620 LOC across 71 `.c` files + headers.
Modules: pipeline (22.8K), store (7.1K), mcp (6.1K), foundation (5.8K),
cli (5.6K), cypher (4.9K), ui (3.4K), discover (3.0K), semantic (2.4K),
graph_buffer (1.9K), watcher (655), simhash (655), git (448), traces (214).

## Findings

### 🔴 1. HIGH — Potential buffer overflow in `strcat` (store.c:4479-4484)

```c
char dir[CBM_SZ_512] = "";  // 512 bytes
for (int k = 0; k <= depth; k++) {
    if (k > 0) strcat(dir, "/");
    strcat(dir, parts[k]);  // unbounded append
}
```

**Problem**: `strcat` appends without bounds checking. `depth < ST_MAX_PATH_DEPTH`
limits the NUMBER of segments but not their TOTAL LENGTH. If path segments
come from file paths with long names (e.g. a 200-char filename), the 512-byte
`dir` buffer can overflow.

**Impact**: Stack buffer overflow → potential RCE if a malicious file path
is indexed (e.g. a repo containing a file with a 500+ character path).

**Fix** (if V1 were to be updated): Use `snprintf` or check remaining capacity:
```c
size_t remaining = sizeof(dir) - strlen(dir) - 1;
if (strlen(parts[k]) + 2 > remaining) break; // overflow prevention
```

**V2 comparison**: V2 doesn't have this pattern — TypeScript string operations
are bounds-safe by design (no fixed-size stack buffers).

---

### 🟡 2. MEDIUM — Unchecked `malloc` returns in list functions (store.c)

5 functions in store.c call `malloc()` without checking the return value:

| Line | Function | Type |
|---|---|---|
| 1152 | `store_list_projects` | `cbm_project_t *arr` |
| 1320 | `store_list_nodes` | `cbm_node_t *arr` |
| 1378 | `store_list_nodes_by_label` | `cbm_node_t *arr` |
| 1570 | `store_list_edges` | `cbm_edge_t *arr` |
| 1784 | `store_list_file_hashes` | `cbm_file_hash_t *arr` |

```c
cbm_project_t *arr = malloc(cap * sizeof(cbm_project_t));
// No NULL check!
while (sqlite3_step(stmt) == SQLITE_ROW) {
    arr[n].name = ...;  // NULL deref if malloc failed
```

**Impact**: On OOM, `arr` is NULL → segfault when writing `arr[n].name`.

**Note**: `safe_realloc` (defined in `platform.h`) correctly handles realloc
failure (frees old buffer, returns NULL). But the initial `malloc` is unchecked.

**V2 comparison**: V2 uses better-sqlite3 which handles allocation internally.
TypeScript's `Array.push()` is OOM-safe (throws instead of segfaulting).

---

### 🟡 3. MEDIUM — `slab_owns()` O(n) scan per free/realloc (slab_alloc.c:94-103)

```c
static bool slab_owns(const slab_state_t *s, const void *ptr) {
    for (const slab_page_t *page = s->pages; page; page = page->next) {
        uintptr_t lo = (uintptr_t)page->data;
        if (p >= lo && p < lo + SLAB_PAGE_SIZE) return true;
    }
    return false;
}
```

Called on every `slab_free()` and `slab_realloc()`. With many slab pages
(large files with many tree-sitter nodes), this is O(pages) per free.

**Comment says**: "Linear scan is bounded: per-file reclaim keeps page count small"
— true for typical files, but pathological cases (very large files) could have
hundreds of pages.

**Fix** (if updated): Use a hash set of page addresses, or maintain a sorted
array of `[lo, hi)` ranges for binary search (O(log n)).

**V2 comparison**: V2 doesn't have a custom allocator — V8's GC handles
allocation. The slab allocator is V1-specific (tree-sitter's allocation
pattern).

---

### 🔵 4. LOW — `slab_realloc` promotion ordering (slab_alloc.c:159-174)

```c
void *new_ptr = malloc(new_size);
memcpy(new_ptr, ptr, SLAB_CHUNK_SIZE);  // copy BEFORE freeing slab slot
slab_free_node_t *node = (slab_free_node_t *)ptr;  // reuse ptr as free node
node->next = tls_slab.freelist;
tls_slab.freelist = node;
return new_ptr;
```

**Safe but subtle**: `memcpy` copies BEFORE the slab slot is returned to the
free list. No use-after-free. But the ordering is fragile — a future edit
that swaps the `memcpy` and the free-list return would introduce a
use-after-free.

**V2 comparison**: N/A (V2 doesn't have a custom allocator).

---

## What V1 does RIGHT (excellent patterns to learn from)

### ✅ Memory management — production-grade

| Component | Pattern | Why it matters |
|---|---|---|
| **Arena allocator** (158 LOC) | Bump allocator, 8-byte aligned, grow-on-demand | Zero-fragmentation batch allocation for pipeline indexing |
| **Slab allocator** (260 LOC) | Thread-local, 64B chunks, free list | Eliminates ptmalloc2 fragmentation (was causing 321GB VSZ) |
| **String interning** (153 LOC) | FNV-1a hash + arena + open-addressing | O(1) dedup, saves ~40% memory on repeated identifiers |
| **mimalloc** | Replaces ptmalloc2 in production builds | Better multi-threaded performance, lower fragmentation |
| **Back-pressure** | RSS budget check, worker naps when over | Prevents OOM on large codebases (bounded overshoot) |

### ✅ Thread safety — correct atomics usage

- `atomic_fetch_add` for work-stealing index (zero contention, natural load balancing)
- `atomic_exchange` for pipeline spinlock (100ms sleep between retries)
- `atomic_int cancelled` for cancellation propagation
- `_Atomic int64_t shared_ids` for unique node IDs across parallel workers
- `CBM_TLS` for thread-local slab state (no contention on tree-sitter allocs)

### ✅ SQLite — well optimized

| PRAGMA | Value | Rationale |
|---|---|---|
| `temp_store` | MEMORY | Avoid disk I/O for sorting/grouping |
| `cache_size` | -65536 (64MB) | Large page cache for bulk operations |
| `journal_mode` | WAL | Concurrent read during write |
| `synchronous` | NORMAL | Balance safety vs performance (WAL safe) |
| `busy_timeout` | 10000 (10s) | Handle concurrent CLI/MCP access |
| `mmap_size` | 64MB default | Memory-mapped I/O for large DBs |
| `foreign_keys` | ON | Referential integrity |

Plus `prepare_cached()` — prepared statement caching (same pattern V2 adopted in R58).

### ✅ Hash table — Verstable (2024 state-of-the-art)

- Open-addressing with 4-bit hash fragment metadata
- Quadratic probing with displacement tracking
- Sidesteps most key comparisons during chain walks
- Better than the previous Robin Hood implementation for hot paths

### ✅ Cypher query engine — SQL injection safe

- `snprintf` for SQL generation (bounded)
- `sqlite3_bind_text` for user values (parameterized)
- No raw `%s` interpolation into SQL

### ✅ Worker pool — well designed

- 8MB stacks (required for deep AST recursion)
- Main thread participates (not just waits)
- Graceful degradation (serial fallback if pthread_create fails)
- Per-file reclaim (keeps peak memory bounded)

## V1 vs V2 — architectural comparison

| Aspect | V1 (C) | V2 (TypeScript) |
|---|---|---|
| **Role** | Code analysis engine | Human memory sidecar |
| **LOC** | 65,620 | 15,430 |
| **Memory mgmt** | Arena + slab + interning + mimalloc | V8 GC (managed) |
| **Thread model** | pthreads + atomics + TLS | Single-threaded (Node.js event loop) |
| **DB access** | SQLite C API (direct) | better-sqlite3 (C bindings, sync) |
| **Hash table** | Verstable (custom, 4-bit metadata) | JS Map (V8 built-in) |
| **String dedup** | Custom intern pool (FNV-1a + arena) | JS string interning (V8 built-in) |
| **Type safety** | C types (weak, manual) | TypeScript strict (strong, 63 rounds) |
| **Buffer safety** | Manual (1 strcat bug found) | Bounds-safe by design |
| **Error handling** | Return codes + error strings | Exceptions + catch(unknown) |
| **Test coverage** | C tests (not audited here) | 378 tests, 0 regression |
| **Security audit** | 1 HIGH (strcat), 2 MEDIUM | R51: 1 CRITICAL + 7 fixes, all resolved |

## Lessons for V2

1. **Arena/slab allocation**: V2 can't replicate this (V8 GC), but the pattern
   of batch-allocation + reset is applicable to the import/generate cycle
   (allocate all vault notes in one pass, then reset).

2. **String interning**: V2's `safeJsonParse` + `safeJsonParseArray` is the
   equivalent of V1's string interning for JSON fields — dedup is handled by
   V8's string table automatically.

3. **Back-pressure**: V2's SWR cache is the equivalent of V1's RSS budget —
   both prevent unbounded resource consumption. V2 could add explicit RSS
   monitoring if needed (currently relies on Node.js heap limits).

4. **Prepared statements**: V1's `prepare_cached` and V2's R58-R59 prepared
   statements are the same pattern — both cache at construction time.

5. **Buffer safety**: V1's `strcat` bug is impossible in V2 — TypeScript
   string operations are bounds-safe. This is a clear win for V2's language
   choice.

## Verdict

V1 is **production-grade C code** with excellent memory management, thread
safety, and SQLite optimization. The 1 HIGH finding (strcat overflow) is
the only real security concern — and it's a pattern that V2's TypeScript
eliminates by design.

The V1 → V2 split is the right architecture: C for the CPU-bound,
memory-sensitive analysis engine; TypeScript for the I/O-bound, interactive
sidecar. The audit confirms that both sides are well-optimized for their
respective domains.
