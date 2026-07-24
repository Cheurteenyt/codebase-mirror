# R184 Ariad versus Graphify competitive truth audit

> **Status:** Current competitive evidence
> **Audience:** Users, maintainers, performance engineers, and product reviewers
> **Last verified:** `0.78.0-alpha.1` / 2026-07-24
> **Baseline Ariad SHA:** `0789b3019d1847605ebe60a3be6abd16363249fe`
> **Post-fix product SHA:** `a699e27626673d29f91344b4b2d6a059ac63d728`
> **Benchmark ID:** `r184-ariad-vs-graphify-2026-07-23`

## Decision

Ariad does not universally beat Graphify or optimized source inspection.
R184 does establish a narrower and defensible reason to choose it:

- Ariad indexes and rechecks the pinned repositories substantially faster than
  Graphify, with stable graph counts and artifact sizes on no-change updates.
- Ariad returns exact, bounded, revision-aware code evidence and explicitly
  reports ambiguity, incompleteness, staleness, and truncation.
- Ariad combines that evidence with a maintained local UI, human-memory store,
  update workflow, and package instead of generating a graph and delegating the
  durable workflow to a second application.
- The post-fix Ariad arm is exact on T01, T02, T03, T07, and T08 across all
  valid repetitions.

The same evidence also establishes real losses:

- Graphify is materially lighter on small-project indexing memory and artifact
  size.
- Graphify's static UI becomes usable sooner.
- Graphify plus Obsidian has the highest post-fix query pass count and is much
  stronger than Ariad on T06.
- Ariad remains weak on cross-domain copy-ready evidence in T04 and minimum
  edit-context selection in T06.
- Every arm fails T05. Human memory is therefore a product capability, not yet
  a demonstrated competitive advantage in this protocol.
- Neither UI completes its strict T09/T10 task family. Ariad is safer and more
  accessible in the measured browser states, but it cannot claim a visual-task
  win.

The correct product direction is not to imitate Graphify. Ariad should retain
its exactness, update, and failure-visibility strengths while fixing evidence
ranking for T04/T06 and making dependency direction immediately legible in the
current single-renderer UI.

## Evidence and contamination controls

The [frozen protocol](../GRAPHIFY_COMPETITIVE_PROTOCOL.md) and
[`spec.json`](../../../scripts/benchmark/r184-graphify-competitive/spec.json)
were committed before scored work. The four arms were:

| Arm | Workflow |
|---|---|
| A | Optimized `rg` plus focused read-only source inspection |
| B | Graphify MCP plus focused source fallback |
| C | Graphify MCP plus deterministic Obsidian export and source fallback |
| D | Ariad bounded MCP and human memory plus the cheapest exact source operation |

The corpus was fixed to the controlled fixture, p-limit at
`df476048d023ff868cd45b35ee47f5fb0ca2b25a`, zod at
`912f0f51b0ced654d0069741e7160834dca742ee`, and FastAPI at
`704fbe1439341994100622853f515a8af7ccc2eb`. Graphify 0.9.25 was isolated
outside the Ariad repository at commit
`2fa6cd3d5548577f8c5f591b713f0bf80c1af183`; its wheel SHA-256 was
`e902205873d129e9c76c11fea4268480042603590290ed600707354e74314c0c`.
Graphify's MIT-licensed implementation was inspected for behavior only. No
implementation or visual design was copied.

The baseline and post-fix evidence were independently sealed:

| Phase | Files | Bytes | Result-manifest SHA-256 | Seal payload SHA-256 |
|---|---:|---:|---|---|
| Baseline | 76,904 | 841,016,669 | `aa577017d3d5b7cb460e052a9453598724f8c76588215ba1323dd272d5dbd44e` | `efd815f15ecb8d5c7f8fc6ba277c999dadabc8e8d066d73656e3d1318aaf8bf2` |
| Post-fix | 76,611 | 833,533,115 | `b92f2ed241b0479e2600a7401d64cd34b2268c2281cfa0310c49a7d289548538` | `8cefc9cee75d788161d5eb5ec33d942b0f4f62e80c27c90d44289b9844bff56a` |

The repository retains the portable protocol, fixtures, graders, orchestration,
and compact [machine-readable summary](../benchmarks/r184-ariad-vs-graphify-2026-07-23/competitive-summary.json).
The 1.67 GB of raw sealed evidence remains external so generated competitor
repositories, virtual environments, caches, databases, vaults, and
machine-specific paths do not enter the product repository.

## What changed after the sealed baseline

The baseline isolated two related root causes.

First, NodeNext source imports such as `./foo.js` were not mapped back to
TypeScript source files on Windows. The resolver also conflated unresolved
module requests with useful file-level dependency evidence. The correction:

- uses portable Node path operations and deterministic TypeScript extension
  substitutions;
- removes the phantom tree-sitter `function` node type;
- persists deduplicated, directed File-to-File `IMPORTS` relationships with
  resolution, confidence, binding, and import-kind evidence;
- advances extractor semantics from 8 to 9, which forces a full reindex rather
  than reusing an incompatible graph.

Second, exact filesystem scopes were available to the UI but did not expose
their complete dependency boundary as one bounded task surface. The
correction:

- computes exact incoming and outgoing boundary totals and groups in SQLite;
- keeps directory membership revision-bound, deterministic, capped, and
  cached;
- promotes an exact directory result in search;
- shows the strongest dependency as a compact direction summary;
- lets `get_module_context("packages/bench")` return an exact bounded
  directory scope with counts and truncation instead of an ambiguous file-name
  match.

The implementation adds no production dependency, renderer, panel, graph
copy, or unbounded transfer. The embedded UI remains inside the existing
JavaScript and CSS budgets.

## Indexing and update result

There were 32 cold cells, 32 no-change cells, and two mutation cells. Every
index/update command exited successfully. Median post-fix results:

| Target | Ariad cold | Graphify cold | Ariad no-change | Graphify no-change |
|---|---:|---:|---:|---:|
| Fixture | 770 ms | 1,224 ms | 523 ms | 1,217 ms |
| p-limit | 756 ms | 1,343 ms | 527 ms | 1,357 ms |
| zod | 2,385 ms | 25,521 ms | 797 ms | 27,857 ms |
| FastAPI | 3,719 ms | 59,095 ms | 2,116 ms | 101,920 ms |

Ariad's no-change graph counts and artifact byte sizes remained stable. SQLite
file hashes changed because the official update writes metadata; this is not
reported as byte-for-byte immutability. Graphify's no-change graph artifacts
grew by median factors from 1.212x to 3.299x, including 3.299x on FastAPI.

This speed win has a cost. Ariad cold peak working set was 361 MiB versus
65 MiB on the fixture and 450 MiB versus 67 MiB on p-limit. On zod and FastAPI
the difference narrowed to roughly 1,021 versus 911 MiB and 1,028 versus
940 MiB. Ariad's SQLite artifact was also larger on three of four cold targets.
The FastAPI exception is operationally relevant: Graphify's 8.12 MiB cold
artifact grew to 26.78 MiB after a no-change extraction, while Ariad remained
at 13.86 MiB.

## Query correctness and token economy

The scored query phase contained 256 primary cells. The evidence auditor
rejected 21 first attempts that used forbidden PowerShell forms. Fourteen
strict reruns were accepted and seven cells remain invalid. Invalid cells are
not silently counted as failures or successes.

### Aggregate post-fix result

| Mode | Arm | Valid | PASS | Uncached tokens p50 | Wall p50 | Calls p50 |
|---|---:|---:|---:|---:|---:|---:|
| Cold | A | 32/32 | 21 | 17,482 | 19,448 ms | 2 |
| Cold | B | 30/32 | 21 | 13,044 | 30,907 ms | 3.5 |
| Cold | C | 30/32 | 22 | 25,927 | 49,725 ms | 8 |
| Cold | D | 29/32 | 21 | 14,487 | 29,607 ms | 4 |
| Warm | A | 32/32 | 22 | 44,622 | 16,777 ms | 2 |
| Warm | B | 32/32 | 24 | 54,570 | 23,927 ms | 3 |
| Warm | C | 32/32 | 27 | 76,526 | 37,970 ms | 5 |
| Warm | D | 32/32 | 22 | 53,268 | 26,203 ms | 3.5 |

Ariad's cold token median improved materially from the sealed baseline:
22,276 to 14,487 uncached tokens. Its warm median worsened from 47,489 to
53,268. Ariad is therefore neither a universal token winner nor a universal
regression. Cold Ariad is close to Graphify hybrid and below optimized source;
warm optimized source remains cheaper and faster.

The graph did not cause every Ariad result. Of 61 valid Ariad cells, 34 used
graph evidence, nine used human memory, and 27 were source-only. The report
does not attribute source-only completions to the graph.

### Task families

| Task | A | B | C | D | Honest conclusion |
|---|---:|---:|---:|---:|---|
| T01 bounded transitive callers | 8/8 | 8/8 | 8/8 | 8/8 | Tie on correctness |
| T02 type impact | 8/8 | 8/8 | 8/8 | 8/8 | Tie on correctness |
| T03 route/command trace | 7/8 | 7/8 | 8/8 | 8/8 | Ariad and C lead |
| T04 cross-domain copy-ready evidence | 3/8 | 5/7 | 4/7 | 2/6 | Ariad loses |
| T05 ADR/risk/rationale | 0/8 | 0/8 | 0/8 | 0/8 | Unsupported product claim |
| T06 minimum edit context | 1/8 | 1/7 | 6/8 | 1/7 | Graphify + Obsidian wins |
| T07 explicit boundedness | 8/8 | 8/8 | 8/8 | 8/8 | Tie; Ariad exposes native bounds |
| T08 edit/rename/delete freshness | 8/8 | 8/8 | 7/7 | 8/8 | Ariad, A, and B lead |

The product correction moves Ariad T04 from 0 to 2 valid passes and T08 from
six valid passes to eight. T04 still fails because the agent frequently ranks
the wrong package-generation evidence above the exact import boundary. T06
still fails because Ariad's minimum-context tool does not reliably prioritize
the one definition, one direct caller, and two construction sites the task
requires. These are evidence-selection defects, not justification for a larger
unbounded graph payload.

T05 is the most important negative result. Ariad used its human-memory surface
in all eight valid cells and still scored zero. The notes exist, but the
retrieval and answer-normalization workflow did not make the controlling ADR,
risk, owners, and constraints reliably actionable. Graphify + Obsidian also
scored zero, so adding Obsidian alone does not solve the task.

## Graph UI result

The blinded visual phase completed 80 of 80 cells across both products,
desktop/narrow viewports, cold/warm states, and controlled/real targets. Every
strict T09/T10 group scored 0/5 for both products.

Selected cold desktop medians:

| Target | Product | First usable | Interaction FPS | Long-task p95 | Accessibility failures |
|---|---|---:|---:|---:|---:|
| Fixture | Ariad | 402.2 ms | 128.2 | 0 ms | 0 |
| Fixture | Graphify | 228.7 ms | 126.2 | 72 ms | 50 |
| zod | Ariad | 750.9 ms | 127.1 | 0 ms | 0 |
| zod | Graphify | 255.7 ms | 126.6 | 188 ms | 180 |

Graphify wins first-useful-render latency. Ariad has fewer long tasks, slightly
higher interaction FPS, zero measured accessibility failures, and no unexpected
console, page, HTTP, clipping, or overlap failures. Those are meaningful
runtime and safety strengths, but task success is the governing metric.

Ariad T09 consistently found the largest areas, both requested symbols, and
restored architecture context, but the frozen task did not expose the
`runPipeline` direction: 3/4 signals. Ariad T10 consistently located
`packages/bench`, found exact `zodNext` evidence, cleared selection, restored
the overview, and remained unclipped: 5/6 signals. Its dependency-direction
signal was recorded false.

An unscored post-seal browser diagnosis opened the same post-fix zod graph and
observed the visible exact-scope HUD within one second:
`References → packages/zod · out:136 in:18`. A direct exact-scope read reported
154 boundary relations: 136 outgoing and 18 incoming. This proves that the
post-fix product contains and renders the direction, while the frozen visual
collector failed to capture it. The sealed score remains 5/6; it is not
retroactively changed. The next protocol must measure the HUD directly without
waiting for a node-detail close action after opening a directory.

## Why choose Ariad instead of Graphify plus Obsidian?

Choose Ariad when the primary job is repeated, safe change preparation on a
living repository:

- fast local reindex and no-change checks;
- exact TypeScript/JavaScript dependency semantics, including NodeNext on
  Windows;
- bounded MCP responses with freshness and failure visibility;
- one maintained graph, human-memory, UI, CLI, and package lifecycle;
- deterministic mutation handling without graph growth on a no-change update;
- accessible, responsive exploration linked to the same exact graph revision.

Choose Graphify or Graphify plus Obsidian when:

- a lighter small-project extractor is more important than update semantics;
- the fastest static first render is the priority;
- the current task resembles T06 and its generated vault provides the needed
  minimum context;
- the user prefers independent generated Markdown artifacts over Ariad's
  integrated lifecycle.

Use optimized source inspection when the question is a cheap literal or exact
file lookup. R184 confirms that a graph is not automatically the most efficient
tool.

## Next narrow product decision

The next round should not add a skin, renderer, global legend, or larger
default payload. It should preregister only the two remaining change-safety
losses:

1. rank exact cross-directory `IMPORTS` evidence above similarly named package
   internals for copy-ready T04 answers;
2. make `prepare_edit_context` return a minimal, role-labelled edit set for
   T06 without broad source fallback;
3. repair the visual scorer, then require visible direction in T09/T10 while
   preserving first-render, accessibility, and bundle budgets;
4. retest T05 only after human-memory retrieval has an explicit controlling
   note/owner/constraint contract.

No universal competitive claim is justified until those families pass across
cold and warm repetitions.
