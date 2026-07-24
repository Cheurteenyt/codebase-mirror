# V2 current state — Codebase Memory V2

> **Status:** Canonical product snapshot
> **Audience:** Users, integrators, contributors, and maintainers
> **Last verified:** `0.78.0-alpha.1` / 2026-07-24 at `a699e27`

This document answers one question: **what is active in the product now?**
Implementation history belongs in the [changelog](../../v2/CHANGELOG.md),
architecture detail belongs in [V2 architecture](../architecture/V2_ARCHITECTURE.md),
and measured claims belong in [performance reports](../performance/reports/).

## Sources of truth

| Fact | Authority |
|---|---|
| Package version and Node engine | `v2/package.json` |
| Dependency graph | `v2/package-lock.json` and `graph-ui/package-lock.json` |
| Extractor and discovery semantics | `v2/src/indexer/schema.ts` |
| CLI behavior | `v2/src/cli/` and [CLI reference](CLI_REFERENCE.md) |
| MCP contracts | `v2/src/mcp/` and [MCP tools reference](MCP_TOOLS.md) |
| Graph UI behavior | `graph-ui/src/` and [Graph UI guide](../../graph-ui/README.md) |
| Release history | `v2/CHANGELOG.md` |
| Native token measurements | [V1/V2 token truth audit](../performance/reports/V1_V2_TOKEN_TRUTH_AUDIT_2026-07-20.md) |
| Current competitive measurements | [R184 Ariad versus Graphify truth audit](../performance/reports/R184_ARIAD_VS_GRAPHIFY_TRUTH_AUDIT_2026-07-24.md) |

Do not copy volatile versions or test counts into new documents. Link to the
authority above.

## Active product path

The shipped product uses this path:

```text
repository
  -> native TypeScript/WASM indexer
  -> legacy <project>.db through defaultCodeDbPath
  -> read-only graph/MCP/UI queries
  -> optional separate <project>.human.db
```

The indexer, MCP server, CLI, and Graph UI all use the legacy project database.
This boundary is intentional and regression-tested.

## Stable capabilities

### Indexing and graph

- Local indexing with prebuilt tree-sitter WASM grammars covering the language
  set declared by the indexer.
- Correctness-first full discovery by default and an explicit reduced-coverage
  fast mode for controlled benchmarks.
- Persistent nodes, edges, call sites, imports, exports, file metadata, and
  discovery state in SQLite.
- Cross-file call resolution is strongest for TypeScript and JavaScript.
  Directed File-to-File `IMPORTS` edges retain exact resolution, confidence,
  binding, and import-kind evidence. Portable NodeNext requests map emitted
  `.js` names back to TypeScript source files on Windows and Linux.
- Content-hash and nanosecond-mtime incremental checks, deletion handling,
  deterministic path normalization, and semantics-version reindex gates.
- Structured freshness and completeness signals rather than silent partial
  success.

### MCP and agent workflow

- Eight read-oriented MCP tools, including bounded exact source lookup and
  `prepare_edit_context`.
- `get_module_context` accepts an exact directory path and returns bounded
  scope membership, internal-edge counts, incoming/outgoing boundary groups,
  linked memory, and explicit truncation.
- Exact source profiles for literal matches, TypeScript type dependents, direct
  callers, tracked top-level inventory, and bounded call chains.
- Deterministic ordering, output bounds, ambiguity, staleness, coverage,
  completeness, and truncation metadata.
- Exact literals and known paths are expected to use the cheapest exact source
  operation; graph evidence is reserved for structural questions.

### Graph UI

- Dashboard, project management, control surface, filters, exact search,
  details, and a bounded graph renderer.
- Structure and Dependencies views share one renderer, selection model,
  keyboard model, and exact-detail contracts.
- Fitted macro domains preview at most two deterministic semantic symbols and
  disclose how many indexed nodes remain inside. The preview is non-interactive,
  reuses loaded topology, and fades before exact symbols take over.
- The overview is an explicit representative sample; exact search and
  snapshot-bound pagination provide off-sample access.
- Exact directory search promotes a distinct directory action. Its compact
  scope HUD exposes the strongest external dependency and exact outgoing and
  incoming totals without adding a permanent panel.
- Responsive navigation, keyboard access, reduced-motion handling, and
  visible partial/error states.

### Human memory and Obsidian

- A separate human-memory SQLite database with full-text search.
- ADR, bug, refactor, convention, risk, module, route, prompt, journal, and
  related note types.
- Bidirectional Markdown vault synchronization that preserves human-authored
  sections.
- Portable forward-slash vault identities and Windows traversal support.

### Packaging and platforms

- The npm package embeds the built Graph UI and supports execution from an
  arbitrary working directory.
- Node.js and package-manager requirements come from `v2/package.json`.
- Linux is covered by the complete CI suite. Windows is a supported CLI and
  local-MCP platform with a focused product, lifecycle, security, and
  publication-invariant smoke matrix.
- Docker runs as a non-root user and validates the packaged CLI and UI assets.

## Current measured boundaries

The native-accounting audit on the pinned small and large targets establishes:

- reproducible V2 beats the official reproducible V1 in task success, calls,
  and raw native tokens in every matched aggregate;
- V2 MCP-only still consumes `1.334x` to `1.786x` the tokens of optimized
  grep/read in the measured aggregates;
- the intended hybrid wins two of four post-fix aggregates but uses no MCP
  evidence, so it does not prove graph-caused token savings;
- exact T09 and T12 operations complete in one evidence call, while continuous
  sessions retain substantial accumulated-context cost.
- the [focused r177 correction rerun](../performance/BENCHMARK_PROTOCOL.md#156-final-bounded-candidate-result), limited to the four r176 multi-hop T01
  cells, improves 0 PASS / 2 PARTIAL / 2 FAIL to 4 PASS with one bounded
  `lookup_source_text` call per cell; raw native tokens fall 79.904% and calls
  fall from 60 to 4. That focused round did not revise T02–T04;
- the [R181 repeated T02-T04 correction](../performance/BENCHMARK_PROTOCOL.md#183-same-n-correction-result)
  later isolates the T02 many-call type-impact gap at N=3 and accepts the new
  `type_dependents` profile: all four targeted B groups pass non-overlapping
  range gates, no selected B group worsens, and the one-shot T02-T04 B/C ratio
  changes from `1.563307x` to `0.833754760x`. The result is protocol-specific,
  and continuous cells remain context-confounded.

These findings are repository- and protocol-specific. Historical `-67%` to
`-87%` scenario estimates are not native transport measurements. See
[Token economy](../performance/TOKEN_ECONOMY.md) for the claim boundary.

The sealed R184 comparison adds a different competitor boundary:

- Ariad's median cold/no-change indexing is faster than Graphify 0.9.25 on all
  four pinned targets, from the controlled fixture through FastAPI;
- Ariad's graph counts and artifact byte sizes remain stable after no-change
  updates, while Graphify artifacts grow by median factors from 1.212x to
  3.299x;
- Ariad is not a universal query or token winner. Its post-fix arm passes 43
  of 61 valid cells, versus 49 of 62 for Graphify plus Obsidian;
- Ariad is exact across all valid repetitions for T01, T02, T03, T07, and T08,
  but remains weak on T04 cross-domain evidence and T06 minimum edit context;
- every arm fails T05, so human memory is not yet a measured competitive win;
- neither Graph UI passes the strict visual task family. Graphify renders
  sooner; Ariad has fewer long tasks, zero measured accessibility failures,
  and no unexpected console, page, HTTP, clipping, or overlap failures.

See the
[R184 report](../performance/reports/R184_ARIAD_VS_GRAPHIFY_TRUTH_AUDIT_2026-07-24.md)
for the sealed evidence, invalid-run policy, and exact claim limits.

## Known limitations

### Retrieval and token economy

- `call_chain entry:"test"` does not yet map the literal name to CLI
  registrations such as `program.command('test [test-filter...]')`. This is
  the confirmed T08 residual defect and can trigger fallback exploration.
- Fixed tool-schema cost, tool selection, and cumulative conversation context
  remain the highest-value token-efficiency problems after exact aggregation.
- Identity-aware `direct_callers(max_depth > 1)` is currently a
  TypeScript/JavaScript semantic profile. It trades a slower isolated query on
  the measured small target for exact bounded output and fewer agent loops.
- Graph evidence must not be claimed when the agent completed a hybrid task
  using source operations only.
- R184 T04 still ranks similarly named package internals above exact
  cross-directory import evidence too often. T06 does not yet return a
  consistently minimal role-labelled edit set.
- Human-memory retrieval found the relevant surface in R184 T05 but did not
  reliably normalize the controlling ADR, risk, owners, and constraints.

### Index precision and coverage

- Cross-file semantic precision varies by language and is strongest for
  TypeScript/JavaScript.
- Some hidden or unsupported file classes can be absent from the graph; tools
  must expose incomplete coverage rather than infer completeness.
- String-literal export names, type-namespace default clauses, and global
  validation of non-star module requests remain known indexer gaps.

### Graph UI

- The graph overview is bounded for predictable transfer and simulation cost;
  it is not an exhaustive drawing of every indexed node.
- Macro signatures summarize domain interiors but do not prove that every
  symbol is present in the representative frame; exact search and scope
  pagination remain the authoritative paths.
- Visual quality and perceived performance require continued measurement
  against the reproducible Graph UI lab, not screenshot-only claims.
- R184 T09 still fails to make one requested symbol-to-symbol direction
  immediately legible. The T10 product renders its exact directory boundary,
  but the frozen collector missed that HUD signal; the sealed 5/6 score remains
  unchanged until a corrected preregistered rerun.

### Windows and inactive publication primitives

- The broad backend suite still contains pre-existing POSIX assumptions such
  as Bash, `chmod`, Unix modes, symlinks, and extensionless `.bin` executables.
  Portable product tests and the required Windows smoke remain authoritative
  until those tests are redesigned.
- The inactive generation-publication durability contract is POSIX-oriented.
  Windows ACL and directory-durability semantics must be designed before that
  path can be activated on Windows.

## Merged but inactive generation publication

R169A and R169B are on `main`; the R169B merge commit is
`15a732d91984e5b4ffa29b4e129ac0d6316c9fca`. Their generation-store resolver,
publisher, CAS, GC, recovery, validation, fd-based copy+hash, and no-clobber
`link` primitives are **MERGED / INACTIVE**.

No production indexer path calls `publishPreparedGeneration`, and no production
reader calls `resolveActiveCodeDb`. The active product continues to use the
legacy `<project>.db` through `defaultCodeDbPath`.

- **R169C — future integration:** wire the publisher into the indexer and its
  outcome contract.
- **R169D — future reader cutover:** resolve generations, migrate legacy data,
  and complete project lifecycle behavior.
- **R169E — paused, not scheduled:** if reactivated, pass the integrated
  crash, concurrency, performance, platform, and activation matrix.
- **R170 — out of scope:** multi-host lease and fencing.

The owner has deliberately paused R169E because the production-scale
reindexing-safety need it addresses has not been demonstrated at the project's
current test scale (2 repositories, no large-scale continuous deployment).
This is not an abandonment: the existing R169 technical work remains available
for reactivation if a real need emerges. `DATA-CARRY-01` remains open and must
not be described as closed while the activation gate is incomplete.

The full inactive contract is documented in
[Atomic generation publication](../architecture/ATOMIC_GENERATION_PUBLICATION.md).

## Next engineering priorities

1. Rank exact cross-directory import evidence for T04 and return a minimal,
   role-labelled `prepare_edit_context` set for T06.
2. Define a controlling-note/owner/constraint retrieval contract before
   retesting T05 human memory.
3. Repair the visual task collector, then improve T09/T10 dependency direction
   without adding a renderer, permanent panel, or unbounded payload.
4. Reduce cumulative context and fixed schema/tool-selection cost without
   weakening correctness or evidence.
5. Remove portable-product tests from POSIX shell assumptions.
6. Revisit generation publication only if production scale demonstrates the
   need; if reactivated, require its missing integration and platform gates.

## Validation contract

Every product change must run the targeted regression, backend typecheck and
build, relevant backend suites, package build, frontend typecheck/build/tests,
and supported-platform CI. Indexer or MCP changes require a fresh rebuild and
reindex. Documentation changes must also run `npm run docs:check` from `v2/`.

The [documentation portal](../README.md) is the authority for document status
and location. Historical round narratives must not be appended here.
