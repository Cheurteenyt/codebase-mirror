# Performance, token economy, and Graph UI audit — 2026-07-15

## Executive result

The candidate improves the expensive paths that matter to an interactive code
graph: layout SQL, graph transfer size, rendered graph size, initial application
JavaScript, and MCP payload density. It also adds repeatable budgets so future
updates can be rejected before a regression ships.

It does **not** claim that every V2 workload is faster than V1. The current
machine did not have a buildable, same-revision V1 binary for a valid
apples-to-apples run. The older v0.17-era R78/R79 series is historical, not a
result for this candidate: R78 measured V2 19.8% slower on the small fixture and
15.3% faster on the large parallel fixture, with 3.1× and 1.6× RSS respectively;
the later R79 timing rerun measured 18.8% slower and 14.8% faster. The repaired
rigorous benchmark harness is the path to a current comparison once the V1
dependency is supplied.

## Measured candidate

The final indexing and 1,000-node layout figures below were measured locally on
the delivered graph: 467 files, 8,978 nodes, and 16,709 edges. The explicitly
labelled 2,000-node diagnostic comparison predates the final documentation and
test additions (8,664 nodes) and is retained only as a transfer baseline.

### Indexing

| Workload | Result |
|---|---:|
| Full parallel reindex, 23 workers | 2.614 s |
| Extraction errors | 0 |
| Incremental smoke | 9/9 scenarios and invariants passed |
| Publication smoke, Ubuntu/WSL Node 22 | 396 ms / 5 generations, all invariants passed |

Full discovery is deliberately the default correctness contract. The faster
discovery mode is explicit and non-incremental. Combining `fast` with
incremental indexing is rejected before database access, so a speed
optimization cannot silently delete or certify stale omitted source families.

### Layout API and graph work

| Requested nodes | Warm response | JSON body | Returned edges |
|---:|---:|---:|---:|
| 1,000 | 54–69 ms (55 ms median) | 480,447 B | 1,887 |
| 2,000 earlier diagnostic baseline | 70–80 ms | 969,531 B | 3,998 |

Before the bulk-edge query rewrite, the earlier 8,664-node graph took
approximately 85–100 ms at 1,000 nodes and 100–125 ms at 2,000. The endpoint now performs one
source-side edge scan and reuses those rows for the bounded incoming sample.

The product cap is 1,000 rendered nodes. Relative to the 2,000-node diagnostic
case, the response body is 50.4% smaller, the simulation receives half as many
nodes, and visible edges fall by 52.8%. Sampling balances labels and degree so
the smaller graph preserves structural variety instead of taking the first SQL
rows.

### Browser transfer and code splitting

| Static asset set | Raw | Gzip |
|---|---:|---:|
| Historical eager HEAD entry + CSS | 313,338 B | 93,697 B |
| Candidate entry + CSS | 291,579 B | 82,576 B |
| Candidate lazy Graph route | 72,321 B | 23,289 B |

The common entry is 11.9% smaller gzip. Opening Graph adds a lazy route, so the
complete static Graph UI is 13.0% larger gzip than the old eager static bundle;
that cost is explicit rather than hidden. Including the graph JSON, however,
the approximate first Graph transfer falls from 1,063,228 bytes
(`93,697 + 969,531`) to 586,312 bytes (`105,865 + 480,447`), a 44.9% reduction
before headers.

The simulation pauses when the document or graph panel is not visible, uses a
bounded force range, applies a weak centering force, and performs one settled
fit only when the user has not already interacted.

### Interactive SQLite and lifecycle budget

The UI keeps the startup project pinned and uses an idle LRU registry with a
steady-state budget of four project entries. A code-graph reader retains a
64 MiB SQLite page-cache budget and a human-memory store retains 8 MiB, so the
intended idle steady-state ceiling is `4 × (64 + 8) = 288 MiB` of configured
SQLite page-cache capacity. These are cache ceilings, not eager resident-memory
allocations; simultaneous leased requests can temporarily defer eviction.

Human stores and code readers are opened lazily where possible, request leases
prevent an in-use handle from being evicted, and shutdown closes every retained
handle. Project aliases use exact bigint device/inode identity when available,
which avoids NTFS file-index rounding and prevents the same physical stores
from bypassing routing or deletion guards under another spelling.

Deletion is also bounded as a lifecycle operation: the code DB, human DB, and
their WAL/SHM sidecars are validated and renamed out of the live namespace
before any tombstone is unlinked. A staging failure rolls earlier renames back;
post-commit cleanup failures are exposed as `cleanup_pending` rather than
turning a logically deleted project back into a live partial pair.

Shutdown uses one global deadline for HTTP, WebSocket, SQLite, and owned index
jobs. After cooperative termination, Windows `taskkill /T` may use the
remaining global budget instead of being cut off after 250 ms; its own bounded
timeout still prevents an unbounded wait. This avoids trading a superficially
short shutdown for orphaned indexer descendants on a busy runner.

### JSON transport bytes (not tokenizer tokens)

`npm run bench:tokens` captures the actual compact MCP JSON string, parses it,
then reconstructs a comparison string locally with
`JSON.stringify(parsed, null, 2)`. It does not request or measure a separate
pretty-response mode from the MCP server.

| Form | Bytes |
|---|---:|
| Locally reconstructed pretty JSON | 41,828 |
| Actual compact MCP payload | 30,066 |
| Whitespace transport bytes avoided | 11,762 (28.1%) |

The fixture's highest-degree file was `v1-reference/src/store/store.c`.
Compact JSON is the MCP output. The 28.1% figure measures only whitespace bytes
in two serializations of the same parsed value; it is not a tokenizer benchmark,
an end-to-end model-token saving, or evidence for the historical -67% to -87%
workflow estimates. Responses separately expose exact counts and truncation,
which can avoid follow-up commands whose only purpose would be discovering
whether data was omitted.

The coverage tools cap each relevant label scan at 5,000 nodes and probe one
extra row to detect overflow. They mark observed totals as lower bounds and
coverage as partial when that probe succeeds. `get_project_overview` also
separates historical bug/refactor totals from `active_bugs` and
`active_refactors`, so an agent does not need a second command to determine
whether work is currently open.

## UI quality and responsive validation

- Dashboard, Graph, Projects, and Control use a consistent visual hierarchy,
  status language, spacing system, and keyboard-visible focus treatment.
- The graph settles into a centered, bounded topology instead of leaving remote
  outliers around the viewport.
- Test provenance is evaluated before structural node shape; File, Module, and
  Class nodes inside test trees therefore obey the same Hide tests filter as
  callable test nodes.
- At 390×844 px, Dashboard, Graph, and Projects have zero horizontal overflow.
- On mobile Graph, the action toolbar begins below the two-line HUD and remains
  separate from the filter control.
- Canvas interactions support touch tap, one-finger pan/node drag, and
  midpoint-anchored pinch zoom, with non-passive listener cleanup.
- The browser console produced no warnings or errors during the responsive pass.

## Regression budgets

| Budget | Threshold | Candidate |
|---|---:|---:|
| `/api/layout` warm latency at 1,000 nodes | < 100 ms | 54–69 ms (55 ms median) |
| `/api/layout` body at 1,000 nodes | < 500 KB | 480,447 B |
| Common entry + CSS | < 85 KB gzip | 82,576 B |
| Compact transport-byte saving vs locally reconstructed pretty JSON | > 20% | 28.1% |
| Graph render cap | ≤ 1,000 nodes | 1,000 |
| Full reindex extraction errors | 0 | 0 |

These are local reference budgets, not universal hardware SLAs. CI protects
functional invariants; a stable dedicated benchmark runner should enforce
latency and memory budgets before they become merge-blocking.

## Remaining limits

- A current same-source V1/V2 CPU and RSS comparison still needs a buildable V1
  binary and pinned fixtures.
- The full Windows suite contains POSIX-only durability and shell fixtures.
- Docker runtime smoke could not run locally because the Linux daemon was
  unavailable; Linux CI is authoritative.
- The inactive generation-store publication path is not yet safe to activate on
  Windows and remains outside the product hot path. Its POSIX smoke benchmark
  passes under Ubuntu/WSL.
