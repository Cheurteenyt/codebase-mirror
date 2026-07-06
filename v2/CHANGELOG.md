# Changelog — Codebase Memory V2

## 0.11.3 — Round 49 (2026-07-07)

9 issues fixed (1 CRITICAL merge, 2 HIGH docs, 1 MEDIUM perf, 5 LOW bug/perf/cleanup).

### Fixes

- #1: R48 merged into working branch.
- #2: README badge URL fixed (GitLab→GitHub Actions).
- #4 MEDIUM PERF: processWikilinks skip for unchanged notes (~10x import speedup).
- #6: client.ts abort message distinguishes timeout vs caller cancel.
- #7: client.ts external-signal listener leak fixed.
- #8: routeLayout reuses SWR-cached graphStatus.total_nodes.
- #9: GraphCanvas edge batching (O(E)→O(1) canvas state changes).
- #10: importer.ts misplaced import moved to top.
- #12: swr-cache stale-hit scheduling guarded by refreshHandlers.has(key).

## 0.11.2 — Round 48 (2026-07-06)

6 issues fixed (1 CRITICAL CI, 1 HIGH bug, 2 MEDIUM bug+test, 2 LOW defensive).

## 0.11.1 — Round 47 (2026-07-06)

10 issues fixed across V2 + Graph UI (3 HIGH, 4 MEDIUM, 3 LOW). 6 new tests.
