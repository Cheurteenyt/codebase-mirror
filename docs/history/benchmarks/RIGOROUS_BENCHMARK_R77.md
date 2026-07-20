# Rigorous Benchmark Report — R77 (2026-07-07)

> ⚠️ **SUPERSEDED by R78 (2026-07-08).** R77's conclusions are wrong on three
> counts: (1) only 5 iterations with no significance test, (2) only the SMALL
> workload (42 files, V2 single-thread path) — missed V2's 21% advantage on
> large workloads, and (3) the V2 dist was stale during R77 measurement.
> See `RIGOROUS_BENCHMARK_R78.md` for corrected numbers and methodology.
> This document is kept for historical reference only.

> **Honest reassessment.** Previous R72-R76 benchmarks compared V2's internal
> extraction time (267ms) against V1's wall time (305ms from R67). This was
> misleading — V2's wall time includes Node.js startup + WASM init that V1
> doesn't have. This report uses proper wall-clock timing for both.

## Methodology

- Both V1 and V2 index the **same directory** (v2/src, 42 TS files)
- 5 iterations each, **alternating** V1/V2 to share OS page cache
- Wall-clock time measured (not internal timers)
- V1: `cbm cli index_repository --mode fast` (process startup + C pipeline)
- V2: `node dist/cli/index.js index` (Node startup + WASM init + extraction + SQLite)

## Results (5 iterations, median)

| Engine | min | median | max | nodes | edges |
|---|---|---|---|---|---|
| V1 (C) | 357ms | **361ms** | 362ms | 537 | 1681 |
| V2 (WASM) | 397ms | **401ms** | 416ms | 819 | 768 |

**V2 is 11% SLOWER than V1 in wall time (40ms difference).**

## Why previous benchmarks were wrong

V2's CLI reports "Duration: 267ms" — but this is only the extraction phase.
The full wall time includes:
- Node.js V8 startup: ~30ms
- WASM runtime init (Parser.init): ~50ms
- WASM grammar load (Language.load): ~20ms
- File discovery: ~5ms
- CLI argument parsing: ~5ms
- **Total startup overhead: ~110ms**
- Extraction + SQLite: ~267ms (what the CLI reports)
- **Full wall time: ~401ms**

V1's wall time includes:
- Process startup (C binary): ~25ms
- Pipeline (discover + parse + extract + write): ~335ms
- **Full wall time: ~360ms**

## Where V2 IS actually faster

**Extraction phase only** (excluding startup):
- V2 extraction: ~267ms (20% faster than V1's 335ms pipeline)
- V1 pipeline: ~335ms

On a **persistent process** (MCP server, UI server), V2's startup is amortized
to zero — only the extraction phase matters. In that scenario, V2 is 20% faster.

## Extraction differences

| Metric | V1 (C) | V2 (WASM) | Notes |
|---|---|---|---|
| Nodes | 537 | 819 | V2 counts anonymous callbacks (arrow functions) |
| Edges | 1681 | 768 | V1 does LSP call resolution + cross-file imports |
| Languages | 158 | 112 | V1 has 46 more niche grammars |
| Binary needed | yes (259MB) | no | V2 loads WASM on demand |

V1 extracts **2.2x more edges** because it does:
- LSP-based call resolution (1085 resolved calls)
- Cross-file import resolution (222 imports)
- Usage tracking (253 usages)
- Semantic analysis (1 inheritance)
- Structure nodes (56 structural nodes)

V2 only does static AST analysis (no LSP, no cross-file resolution).

## Honest conclusion

1. **V2's extraction engine is faster** (267ms vs 335ms, 20% faster)
2. **V2's wall time is slower** (401ms vs 361ms, 11% slower) due to startup
3. **V1 extracts more edges** (1681 vs 768) due to LSP + cross-file resolution
4. **V2 extracts more nodes** (819 vs 537) but partly because it counts anonymous callbacks
5. **V2 doesn't need a binary** — the key architectural advantage

## What we should optimize next

1. **Reduce WASM init time** — defer Parser.init until first parse (saves ~50ms)
2. **Parallelize grammar load with file reading** — overlap I/O and WASM (saves ~20ms)
3. **Add cross-file CALLS resolution** — V2 currently misses ~900 edges V1 finds
4. **Use V2 as a persistent process** — amortize startup (MCP server, watch daemon)
