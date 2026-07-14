# V2 Current State — Codebase Memory

**Version:** 0.75.0  
**Last updated:** 2026-07-14 (R169B-STEP10)  
**Branch:** `v2/r169b-durable-generation-publisher`

## 1. Status Summary

| Component | Status | Notes |
|-----------|--------|-------|
| R169A — Atomic Generation Publication Foundation | ✅ Complete | Foundation for R169B. |
| R169B — Durable Generation Publisher | ✅ Foundation/Inactive | All P0/P1 closed. 228 tests pass. |
| R169B-STEP10 (Bloc B + C) | ✅ Complete | B3, B4, C1, C2, C3 all delivered. |
| Indexer pipeline | ✅ Active | 80+ rounds of refinement. |
| UI server | ✅ Active | HTTP + SSE. |
| MCP server | ✅ Active | 7 tools. |
| Obsidian integration | ✅ Active | Vault sync, generator, importer. |
| Documentation | ✅ Complete | ATOMIC_GENERATION_PUBLICATION, V2_ARCHITECTURE, V2_CURRENT_STATE. |

**R169B remains FOUNDATION / INACTIVE.** The publication pipeline is
fully implemented and tested but not yet wired into the active indexer.
The indexer continues to use the R169A generation store. R169B will be
activated in a future step after the final GPT-5.6 audit.

## 2. R169B Step History

| Step | Date | Description | Status |
|------|------|-------------|--------|
| STEP1 | 2026-07-13 | Module cycle break + type/warning taxonomy | ✅ |
| STEP2 | 2026-07-13 | CAS store + types + validation | ✅ |
| STEP3 | 2026-07-14 | Correctness closure (GPT 5.6 Pass 1) | ✅ |
| STEP4 | 2026-07-14 | Immutability + crash harness + GC/CAS closure (Pass 2) | ✅ |
| STEP5 | 2026-07-14 | Recovery + metadata + CAS + docs closure (Pass 3) | ✅ |
| STEP6 | 2026-07-14 | Deterministic recovery + crash evidence + hardening (Pass 4) | ✅ |
| STEP7 | 2026-07-14 | Recovery completion + concurrency + docs + perf (Pass 5) | ✅ |
| STEP8 | 2026-07-14 | Final foundation closure (Pass 6) | ✅ |
| STEP9 | 2026-07-14 | No-carry foundation closure (Pass 7) | ✅ |
| STEP10 | 2026-07-14 | Bloc B completion + Bloc C crash harness (Final gate) | ✅ |

## 3. Test Suite

### 3.1 R169B-specific tests (228 tests)

| File | Tests | Coverage |
|------|-------|----------|
| `r169b-generation-publisher.test.ts` | 55 | Happy path, validation, token state machine |
| `r169b-publication-crash.test.ts` | 31 | Crash matrix, immutability, GC recovery |
| `r169b-publication-concurrency.test.ts` | 4 | Multi-process race |
| `r169b-concurrency-barrier.test.ts` | 5 | 50-iteration barrier (C1) |
| `r169b-publisher-gc-race.test.ts` | 5 | Publisher/GC race (C2) |
| `r169b-crash-harness.test.ts` | 7 | Fault injection + child crash (C3) |
| `r169b-bloc-b-tests.test.ts` | 21 | B1-B4 dedicated |
| `r169b-generation-cas.test.ts` | 30 | CAS store |
| `r169b-generation-gc.test.ts` | 22 | GC planner + applier |
| `r169b-module-split.test.ts` | 48 | Module structure |

### 3.2 Full test suite

- **Total:** 1775+ tests (all passing).
- **Storage:** 496 tests (including 228 R169B-specific).
- **Indexer:** 80+ test files covering rounds 81-164.
- **UI/MCP:** Integration tests.
- **CI:** Signature gates, phase B structural/runtime tests.

### 3.3 Umask matrix

All R169B tests pass under three umask settings:
- `0022` (default)
- `0000` (permissive)
- `0027` (restrictive)

## 4. Key Invariants

### 4.1 Publication

- **Atomicity:** a generation is either fully visible or not at all.
- **Durability:** `fsync(tempFd)` + `fsync(generations/)` ensure the
  published DB survives a crash.
- **Immutability:** the published DB is a copy (separate inode) from
  the staging DB.
- **Concurrency:** exactly one publisher wins; losers get
  `PUBLICATION_CAS_MISMATCH` (strict — never BUSY or CONFLICT).
- **Token:** single-use, authenticated via private WeakMap. Reverts to
  PREPARED only if no visible mutation.

### 4.2 GC

- **Model A:** CAS lock held during entire deletion.
- **Stale plan detection:** if CAS revision changed between plan and
  apply, the plan is stale and no deletions happen.
- **B3 proof under lock:** re-lstat + re-hash under the lock closes the
  TOCTOU window.
- **Active protection:** the active generation is NEVER deleted
  (defense in depth on top of the catalog).
- **Orphan recovery:** promotion temps are deleted; non-temps are
  retained with a grace period; ACTIVE_NOT_IN_CATALOG triggers CAS
  recovery (disk-aware).

### 4.3 Crash safety

- **fsync(tempFd) failure** → `GENERATION_PROMOTION_DURABILITY_UNKNOWN`,
  promotion blocked, temp cleaned up, token reverts to PREPARED.
- **link(temp, final) EEXIST** → `GENERATION_PROMOTION_CONFLICT`, token
  reverts to PREPARED (reusable).
- **fsync(generations/) failure** → `GENERATION_PROMOTION_DURABILITY_UNKNOWN`,
  temp cleaned up, no manifest.
- **Crash at pre-link** → no manifest, temp orphan present, recovery
  succeeds on next publication.
- **Crash at pre-cas-commit** → manifest may exist but CAS active is
  null; `reconcileFromManifest` fixes on next publish/GC.

## 5. Performance

| Operation | Time (10 MB DB, SSD) |
|-----------|---------------------|
| SHA-256 hash (streaming, 64 KiB) | ~20 ms |
| fd-based copy (64 KiB chunks) | ~10 ms |
| fsync(tempFd) | ~20 ms |
| fsync(generations/) | ~20 ms |
| CAS transaction (BEGIN → COMMIT) | ~5 ms |
| **Total publication** | **~80-130 ms** |
| GC deletion (per generation) | ~40 ms |
| Orphan plan (100 files) | ~5 ms |

The publication benchmark (`scripts/publication-benchmark-r169b.ts`)
runs on every CI build and validates these numbers.

## 6. Pending Work

- **Final GPT-5.6 audit** — the only remaining gate before R169B can
  be activated. The audit will review the full R169B-STEP1 through
  STEP10 implementation.
- **PR R169B** — a single PR will be opened after the final audit,
  merging the `v2/r169b-durable-generation-publisher` branch into main.
- **Activation** — wire the R169B publisher into the active indexer
  (replacing the R169A generation store). This is a future step.
- **Phase benchmark instrumentation** — add per-phase timing to the
  publication pipeline (reserve, prepare, hash, copy, fsync, CAS).

## 7. File Structure

```
v2/
├── src/
│   ├── storage/
│   │   ├── generation-types.ts          # Types, error codes
│   │   ├── generation-paths.ts          # Path derivation
│   │   ├── generation-validation.ts     # Manifest/metadata validation
│   │   ├── generation-publisher.ts      # reserve, prepare, publish, discard
│   │   ├── generation-gc.ts             # plan, apply, orphan recovery
│   │   ├── generation-store.ts          # Public facade (R169A)
│   │   └── internal/
│   │       ├── generation-cas-store.ts       # CAS store (SQLite)
│   │       ├── generation-store-io.ts        # PROD_OPS, atomic JSON
│   │       ├── generation-publisher-ops.ts   # PublisherOps + faultable
│   │       └── generation-layout-io.ts       # ensureDirDurable (B4)
│   ├── indexer/                        # Extractor pipeline
│   ├── intelligence/                   # SWR/TTL cache, graph status
│   ├── ui/                             # HTTP server + routes
│   ├── mcp/                            # MCP server + tools
│   ├── bridge/                         # SQLite RO bridge
│   ├── obsidian/                       # Obsidian integration
│   ├── human/                          # Human notes store
│   ├── reports/                        # Risk/hotspot reports
│   ├── cli/                            # CLI commands
│   ├── config.ts
│   └── constants.ts
├── tests/
│   ├── storage/                        # 496 storage tests
│   ├── indexer/                        # 80+ indexer test files
│   ├── helpers/
│   ├── ci/
│   └── ...
├── docs/
│   ├── ATOMIC_GENERATION_PUBLICATION.md
│   ├── V2_ARCHITECTURE.md
│   └── V2_CURRENT_STATE.md
├── scripts/
│   ├── publication-benchmark-r169b.ts
│   └── ...
├── CHANGELOG.md
├── README.md
├── package.json
└── tsconfig.json
```

## 8. Branch Status

- **Branch:** `v2/r169b-durable-generation-publisher`
- **Commits:** 50+ commits on top of `main`.
- **No PR yet** — the PR will be opened after the final GPT-5.6 audit.
- **No new branches** — all work is on this single branch.
