# R183 Graph UI visual-intelligence report

> **Status:** Current implementation evidence
> **Audience:** Maintainers, frontend contributors, and performance auditors
> **Last verified:** `0.78.0-alpha.1` / 2026-07-23
> **Audited code SHA:** `56ae321d9ef1d92e7ee078c21d86e7c54cb5d808`
> **Repository:** `Cheurteenyt/Ariad`
> **Date:** 2026-07-23

## Decision

V2 should not add a V1 skin or a second graph engine. The matched task review
shows that V2 already provides the stronger evidence workflow: exact off-sample
search, source ranges, revision-bound scope, directed flow, and a defined return
to architecture. A V1-style mode would split layout, interaction, accessibility,
performance, and regression contracts while still lacking those guarantees.

V1 does retain one important perceptual strength: its initial node-and-edge
scene communicates depth immediately. R183 carries that strength into the V2
architecture by making macro-domain interiors informative before drill-down.
It does not copy the V1 visual language.

## Evidence integrity correction

The first R183 baseline was rejected. Lab contract v1 validated the requested
project through `/api/layout`, then used a broad ancestor selector in the V1
project list. With more than one cached project, the browser could open the
first card while the report still attributed the preflight project's 38-node
topology to that frame. Initial captures were also taken after the scripted
pan/zoom gesture.

Commit `d54b6ac6472a42f4f445c74b3251a4df1978551e` establishes lab contract v2:

- select the exact card-local project heading;
- capture and verify the browser's actual layout response;
- compare its project, complete node/edge counts, and topology digest with
  preflight;
- record `layoutUrl`, rendered topology, and screenshot stage;
- capture the settled initial frame before performance interaction.

Consequently, older lab-v1 tables remain historical tuning observations, not
strict V1/V2 renderer evidence.

## Matched runtime result

The official V1 reference is pinned to
`345425a1bbf73fa29f76067a91f6d16dcf6f11a8`. V1 and V2 opened byte-identical
database snapshots and rendered the same complete 38-node / 84-edge topology.
Five cold and five warm samples per variant and mode ran on Windows
10.0.26200 x64, Node.js 24.15.0, Edge 150.0.4078.83, and a 1440 x 960 viewport
at DPR 1.

| Mode | Cache | First useful V1 p50 / p95 | First useful V2 p50 / p95 | Long task V1 / V2 p95 | FPS p50 V1 / V2 | Idle CPU p50 V1 / V2 | Heap p50 V1 / V2 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Architecture | cold | 3864.5 / 4123.1 ms | 407.7 / 425.7 ms | 120 / 0 ms | 165 / 165 | 7.68% / 0.02% | 7.3 / 4.1 MiB |
| Architecture | warm | 3887.7 / 3968.5 ms | 408.7 / 413.9 ms | 83 / 0 ms | 165 / 165 | 8.16% / 0.02% | 7.3 / 4.1 MiB |
| Stellar | cold | 3832.7 / 3935.8 ms | 403.4 / 409.5 ms | 126 / 0 ms | 165 / 165 | 8.32% / 0.02% | 7.3 / 3.9 MiB |
| Stellar | warm | 3841.2 / 3925.6 ms | 395.2 / 403.0 ms | 102 / 0 ms | 165 / 165 | 7.39% / 0.03% | 7.3 / 3.9 MiB |

Both modes are `comparison-candidate`, not automatic winners. The strict
fixture establishes the renderer/runtime direction but is too small for a
meaningful multi-domain perception study.

## Anonymous task review

R183 adds a committed six-domain fixture under
`v2/tests/fixtures/graph-ui-perception-lab`. The V1-created snapshots were
byte-identical, and both renderers returned the same complete 65-node /
136-edge topology. The task sheet was completed before opening the blind key.
This was one evaluator's engineering check, not a human-subject study and not a
performance sample. A mapped to V2; B mapped to V1.

| Task | V2 result | V1 result | Decision |
| --- | --- | --- | --- |
| Identify the three largest areas | `analysis` 23, `delivery` 11, `ingestion` 11 from canvas and exact tree counts | Same ordering from the V1 sidebar, with 22 / 10 / 10 visible counts | Tie |
| Find hidden `legacyScheduleLabel` and open context | 2 actions, about 1.2 s UI latency; exact `orchestration/schedule.ts:12-14`, breadcrumb, and inbound profile | Search and selection worked, but no exact range, context panel, neighborhood, or flow evidence | V2 |
| Determine `runPipeline` direction | 3 actions, 1.777 s; `Outbound hub`, 6 out / 2 in / 8 unique, named relations and directed rails | No arrows, directional counts, or relation list | V2 |
| Return to architecture | Clear selection/search, switch Structure, Fit; six-domain frame restored with filters intact | Selection/search reset exists, but no defined architecture/dependencies context or breadcrumb | V2 |
| Justify a hub | Exact degree split, role, relation types, and named neighbors justify `runPipeline` | Glow/size and a nearly empty selected frame do not justify exact degree | V2 |

V1's initial 3D frame still looked more immediately like a graph. V2's fitted
Structure and Dependencies frames were legible but visually hollow: the user
could see where domains were, but not what was inside or what the next semantic
layer would reveal. That was the highest-value defect.

## Root cause

V2 already loaded representative symbols and a server-selected representative
for each domain. The macro renderer intentionally skipped raw nodes, but it
also removed every interior semantic cue across part of the semantic-zoom
range. In Structure, signatures were initially restricted to the coarse
domain-flow threshold. The default Fit camera sat just beyond that threshold,
creating an empty band before exact topology appeared. The dependency atlas
had the same perceptual gap.

The missing information did not require:

- another API response;
- a full-project client scan;
- another d3 simulation or Canvas;
- unbounded labels;
- a V1 compatibility skin.

It required a bounded preview plan and a continuous semantic handoff.

## Implementation

`buildDomainPreviewPlan` runs once when authoritative graph data changes:

1. sort domains deterministically by exact count and key;
2. retain at most 24 domains;
3. keep the server-selected representative when it belongs to that domain;
4. choose at most one additional informative class, interface, type, method,
   function, field, route, file, module, or section by type priority, exact
   topology rank, size, and stable ID;
5. reject anonymous generated symbols;
6. report the remaining exact domain count as hidden.

Canvas paints at most two small dot/label signatures per large visible domain.
They are not hit targets and do not change selection semantics. Structure keeps
them through the domain-to-community transition and removes them before raw
topology. Dependencies uses a shorter fade so atlas signatures do not overlap
the emerging particle frame. A focused domain restricts preview attention to
that scope. Duplicate inner community captions are suppressed only when the
domain signature already communicates the same key.

The hard upper bound is 48 preview rows, independent of graph size. No network
request, graph copy, force, timer, animation, or per-frame sort was added.

## Packaged-browser contract correction

The first final package smoke failed on the real 1,000-node project after
Dependencies opened its exact macro atlas. The smoke immediately pressed `N`
and required a node, while the product correctly announced `Open a domain or
zoom in for symbols.` This was a stale gate, not permission to bypass the atlas.

Commit `b8a349e3f06a4ec237af18cf9908d1ceaec10625` makes the smoke follow that
explicit product prompt with bounded Zoom-in actions before requiring keyboard
node traversal. Unexpected missing-target announcements still fail closed. The
targeted regression and the packaged Edge run cover the handoff from Structure
to atlas, semantic zoom, node activation, directed focus, Structure restore,
and Fit.

## Responsive macro-fit correction

The final visible check used the in-app browser at 380 x 958 CSS pixels. Fit
computed all 11 Structure-domain bounds, but the shared camera floor clamped
the required scale to 0.1. The two outer domains were therefore clipped even
though their geometry was correct.

Commit `56ae321d9ef1d92e7ee078c21d86e7c54cb5d808` lowers the shared minimum
camera scale to 0.02 across Fit, wheel, pinch, buttons, and keyboard zoom. This
keeps a fitted narrow frame internally consistent and lets users zoom in
gradually instead of jumping back to the old floor. A 380-pixel regression fits
two 200-unit domains separated across 6,400 world units and proves that the
result falls below 0.1 while remaining centered. The packaged product check
then contained every macro domain in both Structure and Dependencies.

## Regression and performance protection

The focused regressions cover:

- deterministic representative-first selection;
- semantic secondary ranking and anonymous-symbol rejection;
- global domain and per-domain row caps;
- truthful hidden counts;
- initial Structure and Dependencies paint;
- semantic-zoom opacity at overview, handoff, detail, and exact-scope states;
- existing empty, disconnected, dense, filtered, exact, keyboard, pointer,
  touch, reduced-motion, and oversized graph behavior through the complete
  Graph UI suite.

Local evidence at the audited code SHA:

| Command | Result |
| --- | --- |
| `npx vitest run src/lib/graph-domain-preview.test.ts src/components/GraphCanvas.test.tsx` | 2 files / 65 tests passed |
| `npm test` in `graph-ui` | 26 files / 237 tests passed |
| `npx tsc --noEmit` in `graph-ui` | passed |
| `npm run build` in `graph-ui` | passed; Graph 38.67 KiB, main 69.30 KiB, CSS 14.91 KiB, manifest JS 122.77 KiB, Radix packages 11 |
| `npm run typecheck` in `v2` | backend and lab configurations passed |
| `npx vitest run tests/benchmark/graph-ui-browser-smoke.test.ts tests/benchmark/graph-ui-lab.test.ts` | 2 files / 10 tests passed |
| `npm run build:package` in `v2` | backend compiled, Graph UI embedded, assets verified, npm audit 0 vulnerabilities |
| Packaged Edge smoke on `codebase-mirror` | Structure, atlas zoom, keyboard node, directed focus, restore, and Fit passed; no console, page, or HTTP error |
| Five-run Architecture comparison | strict 38/84 `comparison-candidate` |
| Five-run Stellar comparison | strict 38/84 `comparison-candidate` |

Documentation validation, backend build, embedded-package build, and packaged
browser validation pass locally. Remote CI, publication, and exact-main gates
remain authoritative and are recorded in the completed R183 handoff.

## Remaining limits and next product question

- The preview names only already loaded representative symbols. `+N more
  inside` explicitly prevents it from being read as exhaustive.
- Domain counts in the dependency atlas are exact; individual preview symbols
  still come from the bounded representative frame.
- The perception result has one evaluator and one engineered fixture. It is
  sufficient to isolate this defect, not to claim universal aesthetic
  preference.
- Product-scale V1 and V2 overviews use different edge-selection policies and
  must remain exploratory unless the data contract is deliberately aligned.

The next Graph UI round should measure navigation continuity on real medium and
large repositories: whether users can move from macro signature to exact scope,
compare two domains, and return without losing their mental map. It should not
add more permanent labels until that task evidence identifies a specific gap.
