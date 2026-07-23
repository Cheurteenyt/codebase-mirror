# Graph UI Performance & Perception Lab

> **Status:** Canonical measurement laboratory
> **Audience:** Frontend contributors, performance engineers, and auditors
> **Last verified:** `0.78.0-alpha.1` / 2026-07-23

## Purpose

This laboratory turns the V1/V2 discussion into reproducible evidence. It does
not select an aesthetic winner automatically and it does not accept two
different sampled graphs as a strict comparison.

The lab separates three questions that were previously mixed together:

1. **Backend and transport** — API latency and payload size, measured by
   `npm run bench:graph-ui`.
2. **Browser runtime** — first useful graph, long tasks, interaction frames,
   cooldown, idle CPU and JavaScript heap, measured by
   `npm run bench:graph-ui:compare`.
3. **Perception and task completion** — anonymous A/B captures plus the same
   five tasks for both variants.

No adaptive node, edge or label budget should be changed from a single
screenshot. The raw report and the task sheet must be inspected first.

## Pinned V1 reference

The source under `v1-reference/` matches upstream commit:

```text
345425a1bbf73fa29f76067a91f6d16dcf6f11a8
```

That commit is from 2026-06-28 and contains the complete React/Three.js V1
frontend plus the C `layout3d` engine. The lab records this commit in every
report. Using a floating `main` or the latest V1 release invalidates the
comparison.

The reference source is already vendored once under `v1-reference/`, with its
upstream MIT notice preserved in `v1-reference/LICENSE`. A separate local
clone/build used by the lab belongs in the ignored
`.codex-runtime/graph-ui-lab/v1-source` directory. V2 discovery always excludes
`.codex-runtime`, so raw measurements and that build clone cannot pollute or
block the product graph.

## The strict same-graph rule

For a strict renderer comparison:

- V1 creates one database from the chosen fixture;
- the V1 and V2 servers open byte-identical snapshots of that database;
- `/api/layout` must return every node on both sides;
- sorted node IDs and sorted `(source, target, type)` edges must have identical
  SHA-256 fingerprints;
- each browser must open the exact project card requested by the run;
- the browser-observed layout URL, project parameter, node/edge counts, and
  topology digest must match the preflight response.

The runner stops before launching a browser if either preflight response is
sampled or a fingerprint differs. It then fails the run if the rendered
identity differs: an API preflight cannot certify a UI that selected another
project. `--allow-sampled` exists only for an explicitly labelled
product-default exploration; its result is graded `exploratory` and cannot
support a V1/V2 superiority claim.

Use the committed `v2/tests/fixtures/graph-ui-lab` fixture for the strict pass.
It deliberately keeps every node degree below both edge ceilings. The complete
repository is a separate product-scale test because the V1 and V2 overview and
edge selection policies differ by design.

Two snapshots are necessary on Windows: SQLite file locks held by a WSL process
and a native Windows process are not interoperable on NTFS. Their file SHA-256
is checked before launch, then the lab independently fingerprints every node
and edge returned by both servers.

## Windows preparation

Prerequisites:

- Node.js and npm versions accepted by `v2/package.json`;
- Microsoft Edge or an explicit Chromium executable;
- Ubuntu under WSL with `git`, `make`, `gcc` and `g++`;
- V1 server on `127.0.0.1:9752` and V2 server on `127.0.0.1:9753`.

Build the exact reference in the ignored runtime directory:

```powershell
wsl bash -lc "git clone --filter=blob:none https://github.com/DeusData/codebase-memory-mcp.git /mnt/d/Mycodex/codebase-mirror/.codex-runtime/graph-ui-lab/v1-source"
wsl bash -lc "git -C /mnt/d/Mycodex/codebase-mirror/.codex-runtime/graph-ui-lab/v1-source checkout --detach 345425a1bbf73fa29f76067a91f6d16dcf6f11a8"
wsl bash -lc "cd /mnt/d/Mycodex/codebase-mirror/.codex-runtime/graph-ui-lab/v1-source && make -f Makefile.cbm cbm-with-ui -j2"
```

Create the isolated caches and index the controlled fixture once. `--%` is
PowerShell's stop-parsing token; it preserves the JSON argument passed through
WSL:

```powershell
New-Item -ItemType Directory -Force .codex-runtime\graph-ui-lab\cache\codebase-memory-mcp
wsl.exe --% --exec env CBM_CACHE_DIR=/mnt/d/Mycodex/codebase-mirror/.codex-runtime/graph-ui-lab/cache/codebase-memory-mcp /mnt/d/Mycodex/codebase-mirror/.codex-runtime/graph-ui-lab/v1-source/build/c/codebase-memory-mcp cli index_repository "{\"repo_path\":\"/mnt/d/Mycodex/codebase-mirror/v2/tests/fixtures/graph-ui-lab\",\"name\":\"graph-ui-lab-controlled\",\"mode\":\"fast\"}"
New-Item -ItemType Directory -Force .codex-runtime\graph-ui-lab\cache-v2\codebase-memory-mcp
Copy-Item .codex-runtime\graph-ui-lab\cache\codebase-memory-mcp\graph-ui-lab-controlled.db .codex-runtime\graph-ui-lab\cache-v2\codebase-memory-mcp\graph-ui-lab-controlled.db
if ((Get-FileHash .codex-runtime\graph-ui-lab\cache\codebase-memory-mcp\graph-ui-lab-controlled.db).Hash -ne (Get-FileHash .codex-runtime\graph-ui-lab\cache-v2\codebase-memory-mcp\graph-ui-lab-controlled.db).Hash) { throw 'DB snapshot mismatch' }
```

Start V1 from WSL:

```powershell
wsl bash -lc "tail -f /dev/null | env CBM_CACHE_DIR=/mnt/d/Mycodex/codebase-mirror/.codex-runtime/graph-ui-lab/cache/codebase-memory-mcp /mnt/d/Mycodex/codebase-mirror/.codex-runtime/graph-ui-lab/v1-source/build/c/codebase-memory-mcp --ui=true --port=9752"
```

In another terminal, start V2 against the parent of the same cache:

```powershell
$env:XDG_CACHE_HOME = 'D:\Mycodex\codebase-mirror\.codex-runtime\graph-ui-lab\cache-v2'
node v2\dist\cli\index.js ui --project graph-ui-lab-controlled --port 9753 --graph-ui-path graph-ui\dist
```

The ordinary development UI at port `9749` remains independent from these
isolated comparison servers.

## Running the laboratory

Install the locked development dependencies, then execute at least five
alternated runs:

```powershell
cd v2
npm ci
npm run bench:graph-ui:compare -- --project graph-ui-lab-controlled --runs 5 --max-nodes 1000 --v2-mode architecture
```

For the Stellar task view, create a separate result set:

```powershell
npm run bench:graph-ui:compare -- --project graph-ui-lab-controlled --runs 5 --max-nodes 1000 --v2-mode stellar
```

Useful options:

| Option | Default | Meaning |
|---|---:|---|
| `--v1-url` | `http://127.0.0.1:9752` | Pinned V1 server |
| `--v2-url` | `http://127.0.0.1:9753` | Current V2 server |
| `--runs` | `5` | Measured cold and warm runs per variant |
| `--max-nodes` | `1000` | Shared layout ceiling used by the topology gate |
| `--v2-mode` | `architecture` | `architecture` or `stellar` |
| `--browser-executable` | Edge on Windows | Explicit Chromium-family executable |
| `--output` | ignored timestamped directory | Raw artifact destination |
| `--allow-sampled` | off | Exploration only; disables strict-graph failure |

Runs alternate V1/V2 and V2/V1 order to reduce cache/order bias. Cold samples
use isolated browser contexts and a cleared HTTP cache. Warm samples prime one
persistent context per variant before measurement.

## Outputs

Each timestamped output contains:

- `report.json` — environment, topology fingerprints, every raw sample,
  summaries and the empty perception answer sheet;
- `summary.md` — concise p50/p95 table;
- `blind-captures/A-*.png` and `B-*.png` — anonymous cold/warm captures;
- `blind-key.json` — the A/B mapping, kept away from participants.

Captures are taken from the settled frame before the scripted FPS gesture.
`report.json` records `layoutUrl`, rendered topology, and
`screenshotStage: pre-interaction`; a capture after pan/zoom is not an initial
perception baseline.

The runner records:

- navigation to first useful graph (layout response plus two rendered frames);
- layout response end and transferred bytes;
- count, total and maximum browser long tasks;
- time until three consecutive low-CPU windows, with a bounded timeout;
- FPS, p50/p95 frame interval and frames over 25/50 ms during the same scripted
  zoom-and-pan gesture;
- idle main-thread CPU and JavaScript heap after interaction;
- console and uncaught page errors.

`comparison-candidate` means only that at least five runs used one complete,
identical topology. It does not mean that either UI won.

## Anonymous task protocol

Do not reveal `blind-key.json` until the sheet is complete. For A and B, record
time, actions, errors, confidence and notes for these tasks:

1. identify the three largest structural areas;
2. find a symbol absent from the initial view and open exact context;
3. determine inbound and outbound direction for a major flow;
4. return to the initial architecture after drill-down;
5. identify a hub or dead-code candidate and justify it from visible evidence.

If a version cannot complete a task, record it as a capability failure rather
than inventing an equivalent interaction. This is especially important for V1,
which does not expose every V2 exact-search or exact-neighborhood workflow.

## Decision rule

Only tune adaptive rendering after all of the following are true:

- strict topology passes for the controlled fixture;
- five or more runs have acceptable dispersion;
- no new console/page error appears;
- p95 frame interval and long tasks explain any visible stutter;
- task time or error rate explains any readability complaint;
- the product-scale sampled run is clearly separated from the strict run.

Keep raw evidence with the decision. A visual change that looks impressive but
increases task errors, hides exactness or leaves the browser busy after cooldown
is a regression.

## Current matched evidence - R183 / 2026-07-23

The current comparison targets code commit
`0e0c4ac694393c2bc0d8ed73c0801e30533fad6c` and lab-contract correction
`d54b6ac6472a42f4f445c74b3251a4df1978551e`. It ran on Windows
10.0.26200 x64, Node.js 24.15.0, Microsoft Edge 150.0.4078.83, and a
1440 x 960 viewport at DPR 1. Both five-run modes are graded
`comparison-candidate`: every browser rendered the same complete 38-node /
84-edge topology and emitted no runtime error.

| Mode | Cache | First useful V1 p50 / p95 | First useful V2 p50 / p95 | Long task V1 / V2 p95 | FPS V1 / V2 p50 | Idle CPU V1 / V2 p50 | Heap V1 / V2 p50 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Architecture | cold | 3864.5 / 4123.1 ms | 407.7 / 425.7 ms | 120 / 0 ms | 165 / 165 | 7.68% / 0.02% | 7.3 / 4.1 MiB |
| Architecture | warm | 3887.7 / 3968.5 ms | 408.7 / 413.9 ms | 83 / 0 ms | 165 / 165 | 8.16% / 0.02% | 7.3 / 4.1 MiB |
| Stellar | cold | 3832.7 / 3935.8 ms | 403.4 / 409.5 ms | 126 / 0 ms | 165 / 165 | 8.32% / 0.02% | 7.3 / 3.9 MiB |
| Stellar | warm | 3841.2 / 3925.6 ms | 395.2 / 403.0 ms | 102 / 0 ms | 165 / 165 | 7.39% / 0.03% | 7.3 / 3.9 MiB |

These results support a runtime advantage on this fixture, not an automatic
aesthetic winner or a product-scale claim. The controlled fixture is too small
and has too little domain diversity for a serious interior-hierarchy task.
R183 therefore used the separate committed
`v2/tests/fixtures/graph-ui-perception-lab` target: 65 nodes, 136 edges, six
domains, byte-identical V1/V2 snapshots, and a single-evaluator blind
engineering task sheet. That study is task evidence, not a performance sample
or human-subject study.

The blind key mapped A to V2 and B to V1. Both identified the largest areas.
V2 completed exact hidden-symbol context, directed-flow, context restoration,
and hub-justification tasks; V1 could search and select, but lacked the exact
source range, directional counts/rails, defined architecture return path, and
visible degree evidence required by those tasks. V1 still provided stronger
immediate node-and-edge spectacle. The actionable V2 defect was therefore not
missing data or a second renderer: fitted Structure and Dependencies domains
were visually hollow.

R183 addresses that defect with a load-time, deterministic plan capped at 24
domains and two already loaded semantic symbols per domain. Structure and the
exact dependency atlas paint those non-interactive signatures plus a truthful
hidden-count disclosure, then fade them before raw topology becomes readable.
No request, topology copy, d3 force, hit target, or exactness claim was added.
The detailed evidence and remaining limitations are in the
[R183 Graph UI visual-intelligence report](reports/R183_GRAPH_UI_VISUAL_INTELLIGENCE_2026-07-23.md).

## Local evidence — 2026-07-17

> **Historical / superseded for current V1/V2 comparison.** Lab contract v1
> preflighted one API project but did not record or verify which project and
> topology the V1 browser actually rendered. R183 reproduced a case where the
> broad V1 card selector opened a 4,287-node project after a valid 38-node
> preflight. The tables below remain as tuning history, but they cannot support
> a strict cross-version claim. Use the lab-v2 R183 section above.

The following measurements were collected on Windows 10.0.26200 x64 with
Node.js 24.15.0, Microsoft Edge 150.0.4078.65, a 1440 x 960 viewport at DPR 1,
five cold and five warm runs per mode, and no console, page or unexpected HTTP
errors. Times are medians unless a p95 is shown.

### Strict controlled fixture

Both renderers received the same complete topology: **38 nodes / 84 edges**,
with identical node and edge fingerprints.

| Mode | Cache | First useful V1 p50 / p95 | First useful V2 p50 / p95 | Long task V1 / V2 p95 | Interaction FPS V1 / V2 | Cooldown V1 / V2 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Architecture | cold | 1705 / 2702 ms | 407 / 424 ms | 171 / 0 ms | 165 / 165 | 0/5 / 5/5 |
| Architecture | warm | 1772 / 2406 ms | 410 / 416 ms | 200 / 0 ms | 165 / 165 | 0/5 / 5/5 |
| Stellar | cold | 1744 / 1866 ms | 406 / 439 ms | 151 / 64 ms | 165 / 165 | 0/5 / 5/5 |
| Stellar | warm | 1720 / 1825 ms | 408 / 411 ms | 125 / 50 ms | 165 / 165 | 0/5 / 5/5 |

The controlled comparison supports the runtime claims: V2 reaches a useful
graph roughly four times sooner, reaches quiescence in every run, and preserves
the same sampled interaction cadence. It also isolates a Stellar-specific cost:
V2 Architecture produces no long task on this fixture, while Stellar still
produces a 50–64 ms initialization long task.

### Product-scale sampled run

The product index contains **4287 nodes / 14553 edges**. At the 1000-node API
limit, V1 returned 1000 nodes / 524 edges and V2 returned 1000 nodes / 2200
edges, with different sampled node sets. These results are therefore
**exploratory sampled evidence**, not a renderer-only V1/V2 verdict.

| Mode | Cache | First useful V1 p50 | First useful V2 p50 | Long task V1 / V2 p95 | Idle CPU V1 / V2 | Cooldown V1 / V2 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Architecture | cold | 3075 ms | 621 ms | 264 / 55 ms | 15.22% / 0.01% | 0/5 / 5/5 |
| Architecture | warm | 3039 ms | 626 ms | 366 / 97 ms | 17.89% / 0.02% | 0/5 / 5/5 |
| Stellar | cold | 3715 ms | 630 ms | 377 / 124 ms | 16.95% / 0.02% | 0/5 / 5/5 |
| Stellar | warm | 3049 ms | 636 ms | 282 / 78 ms | 16.47% / 0.02% | 0/5 / 5/5 |

Focused retained-heap reruns after an explicit garbage collection measured
about **8.07 MiB** for V1, **5.02 MiB** for V2 Architecture and **5.34 MiB**
for V2 Stellar. The much larger and variable pre-GC V2 readings are allocation
churn, not evidence of a retained leak; both values are kept in the raw report
so this distinction cannot be hidden.

### Honest conclusion

- V2 is superior on measured startup, cooldown, idle CPU and retained heap.
- Stellar has a reproducible synchronous initialization and transient-allocation
  cost that should be profiled before adding more visual complexity.
- No aesthetic or task-success winner is declared until the anonymous A/B task
  sheet is completed; the runner intentionally leaves `automaticWinner` null.
- Existing adaptive rendering budgets remain unchanged until a trace identifies
  the Stellar bottleneck and a regression test protects the fix.

## Stellar rendering follow-up - 2026-07-17

The earlier result above is retained as the before-state. A source-mapped CPU
profile, Canvas operation counters and repeated cold-page runs isolated two
separate costs: discarded startup work and sustained full-topology relaxation.

The implementation now:

- refuses to fit or paint the browser's disposable 300 x 150 Canvas;
- makes resize idempotent and coalesces the initial large-graph fit;
- avoids constructing Architecture forces immediately before Stellar replaces
  them;
- paints quiet Stellar symbols in spectral/rank batches (at most 40 fills for
  the current ten-color, four-tier palette) while preserving every node and hit
  target;
- exposes secondary edges by projected-spacing LOD while retaining a hub
  backbone at overview scale;
- keeps deterministic micro-symbols fixed and relaxes only semantic hubs when
  an unselected Stellar overview contains at least 500 nodes; selecting a node
  or switching to Architecture restores the complete simulation node set.

Targeted regressions cover first-size paint ordering, a single data-refresh
paint, isolated batched subpaths, full node representation, force construction,
deferred large fits, reduced hub simulation and restoration of the complete
simulation. The focused `UiServer` browser check retained its exact 26-edge
neighborhood, and switching back to Architecture retained 1000 nodes / 1458
edges.

### Follow-up measurements

- Controlled 38-node fixture: Stellar produced **0 long tasks in 6 starts**;
  Architecture produced one 51 ms cold outlier in 6 starts.
- Product 1000-node sample: first-window Stellar Canvas clears fell from 143 to
  138. Architecture fell from 158 to 154 through the shared startup changes.
- A 2.4 s source-mapped Stellar profile reduced sampled d3 force self-time from
  roughly **590 ms to 75 ms** (about 87%) after hub-only overview relaxation.
- `traceNodePath` self-time fell from roughly 20 ms to 5 ms after batched
  micro-symbol rendering.
- The production bundle remains inside the unchanged budgets: Graph 38.44 KiB,
  main 70.89 KiB, CSS 11.87 KiB and manifest JavaScript 124.11 KiB.

The product-scale run still records a roughly 50-77 ms startup task under the
strict 50 ms observer threshold, with occasional Architecture outliers as well.
That task belongs to the combined initial React/UI commit rather than sustained
Stellar relaxation, so this follow-up does not claim the strict product-scale
long-task target is solved. It does establish a protected reduction in ongoing
CPU and rendering work without hiding topology or relaxing a bundle budget.

## Stellar visual-hierarchy follow-up - 2026-07-17

The later visual pass groups top-level paths into contiguous elliptical sectors,
strengthens only the hub backbone, and precomputes a 12-item informative-label
plan. Sector summaries, hub membership and label candidates are rebuilt on a
semantic-frame change; no 1,000-node grouping or sort was added to Canvas paints.

The unchanged five-run API benchmark on the current 10,319-node index returned
the 1,000-node / 1,458-edge sample with layout gzip p50 **91.182 ms** and
**88.38%** wire savings. Exact search p50 was **15.255 ms** and the exact
`UiServer` neighborhood p50 **1.554 ms** for 26 connections. These timings guard
the data path but do not replace a browser frame-time trace. The production
build remains inside the unchanged limits: Graph **39.05 / 40 KiB** and manifest
JavaScript **124.98 / 125 KiB**.

## Stellar community-caption follow-up - 2026-07-17

The interior hierarchy now reuses the server-authored community catalog instead
of adding a second client grouping structure. On a semantic-frame change, the
six largest represented communities with at least four shown nodes select their
highest-ranked informative symbol as a stable angular anchor. Canvas paints
visit only that bounded six-item plan; captions share the existing collision
boxes with sectors, hubs, and symbols.

The three generic inner guide rings were removed because they encoded no project
fact. The product check still showed all 1,000 nodes / 1,458 edges, exposed
community captions such as `graph-ui/src/components`, `v2/src/storage`, and
`v2/tests/storage`, opened the exact `UiServer` focus with 22 selected nodes and
26 connections, and returned to Architecture without losing selection. The
frontend passes **22 files / 170 tests**. The unchanged budgets pass at Graph
**39.07 / 40 KiB** and manifest JavaScript **124.99 / 125 KiB**.

## Structure / Dependencies clarity follow-up - 2026-07-17

The product vocabulary now names the two tasks rather than their rendering
implementation: `Structure` exposes containment and `Dependencies` exposes a
directed neighborhood. Stored `architecture` / `stellar` values remain stable.
A persistent two-option segment and one compact live guide make both choices
discoverable without adding a panel or duplicating graph state.

At domain overview scale, Structure paints at most 12 pre-sorted community
captions and rejects circles smaller than 18 projected pixels. Captions reuse
the domain collision boxes. The same change removes the former per-paint
cluster clone/sort and domain `Map` allocation; the active community is visited
first over the already sorted server plan.

The 1,000-node / 1,458-edge product frame retained seven domains and 52
represented communities while exposing useful interior labels in `v2`,
`v1-reference`, and `graph-ui`. The frontend passes **22 files / 171 tests**,
V2 typecheck and build pass, and the unchanged production limits pass at Graph
**39.06 / 40 KiB**, manifest CSS **11.83 KiB**, and manifest JavaScript
**124.99 / 125 KiB**.

## Dependencies focus-density follow-up - 2026-07-17

The constrained two-panel product frame showed that the camera already consumed
nearly all safe horizontal width. The remaining empty area came from the world
geometry: depth four was **3.117x** farther than depth one, while a representative
24-node fan-out occupied only **240** vertical world units. Fitting that wide,
shallow box necessarily made symbols look small.

The directed plan now uses a 156-unit first column and a 0.72 depth exponent.
Four rails remain strictly ordered, but depth four falls below **2.8x** depth
one. Moderate layers may use 60 units between rows and therefore occupy at
least **300** vertical units in the protected fixture; the existing 760-unit
cap still bounds very large fan-outs. The Canvas transform remains uniform and
no node, edge, depth, or label is hidden.

The narrow `UiServer` product check retained all 1,000 overview nodes, 1,458
edges, 22 selected nodes and 26 exact connections. The four directed depths
remain inside the safe frame while the protected narrow-canvas zoom rises to
**0.59**. The frontend passes **22 files / 173 tests**, V2 typecheck and build
pass, and no per-frame work was added.

## Structure exact-directory follow-up - 2026-07-17

The filesystem tree previously reused a layout community whenever both had the
same path key. On the product database, selecting `v2/src` therefore described
325 sampled tree items but focused a two-node representative community; its
manual exact action returned only 22 nodes. The tree now issues a distinct
`directory` scope and community selection enters exact symbols immediately.

The product endpoint reports **1,634 exact nodes / 3,022 internal edges** for
`v2/src`. Its bounded first page returns 125 nodes and 125 edges in 55,095
bytes, with an explicit continuation cursor. The local cold request measured
48.9 ms and two warm requests measured 8.1 ms and 7.0 ms. Browser interaction
to the first useful exact frame measured about 1.2 s for the directory and
0.96 s for a community, including UI interaction and paint.

No Canvas paint-loop work was added. Directory membership is queried only on
explicit drill-down, cached in a 24-entry revision-bound LRU, and pages retain
the existing 125-node client limit. The frontend passes **22 files / 175
tests**. Targeted backend scope/route tests, both typechecks, the Graph UI build,
and `build:package` pass. Existing gzip limits remain unchanged at Graph
**39.09 / 40 KiB**, manifest CSS **11.81 KiB**, and manifest JavaScript
**124.99 / 125 KiB**.

## Structure exact-hierarchy follow-up - 2026-07-17

The exact-directory fix made `v2/src` truthful, but its first 125 ID-ordered
symbols occupied only three of the twelve directories in the scope. The former
uniform disk and the first hierarchy draft therefore produced the same product
failure in different forms: a sparse frame that did not communicate the code
structure without loading more pages.

The backend now computes one deterministic directory -> file -> symbol plan
from the complete revision-bound membership. It is capped at 12 directory
surfaces, 48 selected files, and at most one aggregate file surface per
directory (60 file surfaces maximum). The first exact response for `v2/src`
contains 12 directories and 54 file surfaces with exact all-node counts while
still returning only 125 / 1,634 symbols and 125 edges. GraphCanvas paints that
complete bounded architecture, but raw nodes and edges remain limited to the
pages actually loaded.

The layout metadata is 7,438 bytes inside a 64,562-byte first response. Five
warm requests measured 14.0, 12.8, 12.4, 12.8, and 12.5 ms locally (12.8 ms
median). Continuations omit the already retained layout: the immediate
edge-only page drops from 9,000 to 1,552 bytes, and the next node-bearing page
drops from 64,524 to 57,076 bytes. The plan is cached with exact membership;
node coordinates are hash-stable across pages, and no Canvas per-frame scan,
second renderer, or additional frontend request was added.

The frontend passes **22 files / 176 tests**; the targeted V2 layout/route
regressions pass, both V2 typechecks pass, and `build:package` passes. The
unchanged limits remain green at Graph **39.14 / 40 KiB**, manifest CSS
**11.76 KiB**, and manifest JavaScript **124.98 / 125 KiB**.

## Structure exact-symbol focus follow-up - 2026-07-17

Selecting `registerObsidianCommand` inside the exact `v2/src` frame previously
reconstructed overview navigation and silently replaced the 125 / 1,634 exact
scope with the 1,000 / 10,319 representative frame. Only eight sampled nodes
were then highlighted, so the detail appeared useful while its visual context
was no longer the requested directory.

Selection now preserves the exact scope and derives emphasis from its merged
visible topology. The product check remains at **125 nodes / 125 edges**, keeps
the `Structure -> v2 -> src -> registerObsidianCommand` breadcrumb, and opens
the detail with **100 exact connections**. Unloaded directory/file surfaces are
still drawn from the complete bounded plan, but keyboard community browsing
only targets the nine file groups that currently contain loaded symbols; it no
longer zooms into a large empty file surface.

No endpoint, simulation, renderer, or Canvas paint-loop scan was added. The
frontend passes **22 files / 176 tests**, including regressions for exact-scope
retention, visible relation emphasis, and loaded-only keyboard targets. Both
frontend and V2 typechecks pass, `build:package` passes, and the unchanged gzip
limits remain green at Graph **39.14 / 40 KiB**, manifest CSS **11.76 KiB**, and
manifest JavaScript **124.98 / 125 KiB**.

## Structure domain-insight follow-up - 2026-07-17

The truthful Structure overview still required the user to mentally connect a
domain title, several community captions, and faint macro bundles. Adding a
persistent card or more idle labels would have duplicated information and made
the seven-domain frame noisier.

Pointer and keyboard focus now share one progressive domain lens. On the
10,319-node product graph, focusing `v2` keeps the sampled 1,000-node overview
and surrounding domains as context, but gives `v2` the active semantic surface,
shows its exact **6.1k-node / 25-group** summary, prioritizes related directed
bundles, and limits community captions to that domain. Leaving focus restores
the unchanged idle overview.

The implementation merges two former focus paint paths and filters the existing
bounded caption pass; it adds no request, renderer, simulation mutation, or
per-node paint pass. The frontend passes **22 files / 177 tests**, V2 typecheck
and `build:package` pass, and gzip remains unchanged at Graph **39.14 / 40 KiB**,
manifest CSS **11.76 KiB**, and manifest JavaScript **124.98 / 125 KiB**.

## Dependencies first-hop preview follow-up - 2026-07-17

The quiet Dependencies overview exposed importance and project sectors, but it
still required a click before showing why a symbol mattered. A large floating
preview would have duplicated nodes, hidden topology, and added another layout
grammar. The retained design therefore stays inside the existing constellation.

Pointer hover and virtual keyboard node focus now brighten a bounded first hop
in the nodes' real settled positions. Each of the five existing semantic edge
groups contributes at most two incident relations, so the transient layer paints
no more than ten edges. It reuses the group color/dash grammar and the exact-flow
direction marker, adds one focus ring and one `VISIBLE FIRST HOP` label, and
performs no request, d3 restart, coordinate mutation, filter change, or navigation.
Click/Enter removes the preview before the existing multi-hop exact focus opens.

Pointer state is cleared when the visual mode, selected focus, or authoritative
server revision changes, while an intentional keyboard target remains the
fallback after pointer exit. The former persistent DOM guide and its duplicate
edge scan were removed; selected direct-relation groups/counts now come from the
already precomputed flow batches and appear only in the Canvas focus label.

The frontend passes **22 files / 180 tests**. Typecheck and production build
pass without raising budgets: Graph **39.15 / 40 KiB**, manifest CSS
**11.63 KiB**, and manifest JavaScript **125.00 / 125 KiB**.

## Adaptive label placement follow-up - 2026-07-17

The previous label pass ranked useful symbols correctly but spent its budget
before collision placement. A dense center could therefore reject most of the
first candidates without allowing later, readable symbols to fill the remaining
attention slots. Structure also exposed only one right-facing anchor, and the
safe viewport check applied only to a selected Dependencies frame.

The shared Canvas pass now derives its paint budget from screen area with
scene-specific caps. Selection, keyboard focus, and transient preview targets
enter first; ranked candidates continue until the number of successfully placed
labels reaches the paint budget. The candidate scan is at most four times that
budget and never exceeds 96, independently of the 1,000-node sample. Structure
reuses the three deterministic outside-first anchors from the flow grammar, and
every symbol label now passes the graph-control viewport guard.

No request, node scan, simulation mutation, coordinate change, or continuous
optimizer was added. A regression starts with 18 deliberately colliding
priority symbols and proves that useful lower-ranked labels backfill the frame
without exceeding the adaptive limit. The frontend passes **22 files / 181
tests**; frontend and V2 typechecks, the production build, and `build:package`
pass. Unchanged limits remain green at Graph **39.15 / 40 KiB**, manifest CSS
**11.63 KiB**, and manifest JavaScript **125.00 / 125 KiB**. The final packaged
asset was served locally; keyboard preview, zoom, and view switching produced no
browser log errors.

## Packaged browser gate follow-up - 2026-07-17

The package smoke previously proved that the installed tarball served its HTML,
hashed JavaScript/CSS assets, and exact layout/search/neighborhood/scope API
contracts. It did not execute React in a browser, so a broken dynamic import,
canvas mount, keyboard path, or view-control interaction could still pass CI.

`npm run smoke:graph-ui:browser -- --project <name> --base-url <url>` now runs a
bounded Playwright smoke against an already running packaged server. It requires
a useful non-empty Canvas, the selected project and Graph tab, then exercises
Structure -> Dependencies -> semantic zoom when the exact atlas requests it ->
keyboard node preview -> Enter selection -> Structure -> Fit. The run fails
closed unless the selected dependency frame exposes `semantic-depth-v2`, the
keyboard status announces a node, Structure is restored, and console errors,
uncaught page errors, and failed HTTP responses are all empty.

The npm-package job installs the Chromium revision associated with the locked
`playwright-core` dependency into an explicit `PLAYWRIGHT_BROWSERS_PATH`, kept
independent from the isolated application `XDG_CACHE_HOME`, and invokes this
script against the indexed tarball fixture after the existing HTTP/data
assertions. Unit regressions lock both the workflow wiring and the fail-closed
observation contract. A local packaged run
passed with Edge 150 on a 1,176 x 904 canvas and the 10,319-node project index;
the visible in-app run also switched views with no browser warnings or errors.

Frontend **22 files / 181 tests**, focused V2 contract tests, frontend and V2
typechecks, and `build:package` pass. No runtime UI code or bundle allowance was
added: the strict limits remain Graph **39.15 / 40 KiB**, manifest CSS
**11.63 KiB**, and manifest JavaScript **125.00 / 125 KiB**.

## Dependencies hub-label orbit follow-up - 2026-07-18

The product Dependencies frame selected useful hubs, but each name was offset
only from its own symbol. Because high-degree symbols intentionally occupy the
center, their labels recreated a dense text knot in the same narrow area. A
protected central fixture placed its label only **17 screen pixels** from the
semantic origin.

Overview hub names now retain their deterministic radial direction but remain
outside a **72-pixel screen-space quiet core**. Symbols already beyond that
orbit keep their previous anchor. The rule scales through the existing zoom
unit, changes no node or edge coordinate, and adds no request, graph scan,
simulation work, label count, or continuous optimizer. Focused Dependencies
and Structure keep their existing placement grammars.

The same 1,000 / 10,319-node product frame keeps all seven exact domains and 52
represented communities while giving central symbols and their names separate
attention layers. The frontend passes **22 files / 182 tests**; the packaged
browser path, keyboard flow, frontend typecheck, production build, and
`build:package` pass with no browser warning or error. Existing gzip limits
remain green at Graph **39.14 / 40 KiB**, manifest CSS **11.63 KiB**, and
manifest JavaScript **124.98 / 125 KiB**.

## Dependencies semantic-label follow-up - 2026-07-18

The 72-pixel orbit separated names from the topology, but the product overview
still spent scarce attention on short, context-free identifiers such as
`option` and `commit`. This weakened anonymous task 5 (identify and justify a
hub) even though the underlying degree ranking was correct.

Project-scale Dependencies labels now reject anonymous names and isolated
lowercase identifiers of at most seven characters. Specific compound names
such as `runBenchmark`, `CodeGraphReader`, and `registerHumanCommand` remain
eligible. The rejected symbols are not hidden: search, semantic zoom, keyboard
browsing, hover preview, and exact focus still expose them. The classifier runs
only when the semantic frame changes; the label count, bounded candidate scan,
Canvas paint, node positions, edge batches, requests, and simulation are
unchanged. The orbit normalization also covers sub-unit central coordinates,
which previously reached only 36 of the required 72 screen pixels.

On the same 1,000 / 10,319-node product frame, a fresh Dependencies capture no
longer gives overview slots to `option`, `commit`, `main`, or `fail`; more
specific symbols and module captions backfill the existing placement budget.
This is a focused V2 task-readability improvement, not a new V1/V2 superiority
claim: the pinned
controlled comparison above remains the reference for cross-version runtime
claims.

The frontend passes **22 files / 201 tests**, its typecheck, `build:package`,
and the packaged browser smoke. The smoke preserves keyboard access to generic
symbols and reports no console, page, or HTTP error. Strict gzip limits remain
green at Graph **39.11 / 40 KiB**, manifest CSS **11.63 KiB**, and manifest
JavaScript **124.95 / 125 KiB**.

## Selected-symbol flow profile follow-up - 2026-07-18

The focused Dependencies frame already arranged incoming and outgoing symbols,
but its detail panel opened with four isolated numbers followed immediately by
a long relation list. In the product fixture, understanding `GraphTab` as an
outward-facing hub required manually reconciling `61` outgoing, `1` incoming,
`62` unique, and the repeated `contains` headings.

The selected-symbol header now turns those same exact-neighborhood facts into a
compact flow profile. It classifies the visible role as `Outbound hub`,
`Inbound hub`, `Connector`, `Outbound only`, `Inbound only`, `Self-linked`, or
`Isolated`; keeps the accessible outgoing, incoming, unique, and risk values;
and names the dominant loaded relation in each external direction. The
coverage marker distinguishes loading, representative overview, partial exact,
and complete exact data. Exact self-loops are subtracted before classification,
so a self-reference cannot be mislabeled as a bidirectional connector.

The profile replaces the previous counter row and redundant completion text.
It adds no request, graph traversal, Canvas paint, simulation mutation, polling,
or overview work; `NodeDetailPanel` remains dynamically loaded only after a
selection. Navigating from `GraphTab` to its line-111 child changed the profile
from `Outbound hub` to `Inbound only`, then restored the original profile when
navigating back, proving that the summary follows the exact selected anchor.

The frontend passes **22 files / 208 tests**, its typecheck and production
build, and `build:package`. The packaged 1,000 / 10,319-node frame exposes the
new profile through the accessibility tree. Strict gzip limits remain green at
Graph **39.11 / 40 KiB**, manifest CSS **11.54 KiB**, and manifest JavaScript
**124.95 / 125 KiB**.

## Exact coupling-path follow-up - 2026-07-18

The selected-symbol profile explained immediate flow, but it could not answer
why two non-adjacent symbols were related. Trying to infer that answer from the
1,000-node representative frame would be incorrect: an intermediate symbol or
relation can be absent from the sample even when the complete graph connects
the endpoints.

The detail panel now exposes one explicit `Trace connection from here` action.
The next symbol chosen through the existing exact project search or map becomes
the target. A revision-stable backend BFS returns the deterministic shortest
coupling chain, ordered symbols, intermediate file paths, and original relation
directions. It traverses relations in either direction because the task is
architectural coupling, not call-flow execution. Six hops, 5,000 visited nodes,
and 20,000 inspected edges bound event-loop and SQLite work. Exhaustion is an
exact `not_found`; depth and safety stops remain visibly inconclusive.

The budget pass also confirmed that Tailwind v4 had no semantic color theme:
production CSS omitted classes such as `text-foreground`, `text-primary`, and
`border-border`. The palette is now registered explicitly. Static detail and
graph-control styling moved from lazy JavaScript into CSS, and the Vite target
now matches the existing ES2022 TypeScript/browser contract. The resulting
production assets stay below every unchanged limit: Graph **38.03 / 40 KiB**,
manifest CSS **14.84 / 15 KiB**, and manifest JavaScript **124.11 / 125 KiB**.
The frontend passes **23 files / 214 tests** and the focused reader/HTTP
contract passes **29 tests**. On the 10,319-node local product graph, a known
two-hop path inspected 203 relationships in **14.09 ms**; an inconclusive
six-hop search inspected 4,617 relationships in **54.29 ms**. These are smoke
observations, not cross-version benchmark claims. The packaged Edge smoke and
the visible in-app workflow report no console, page, or HTTP failure.

## Exact dependency-atlas follow-up - 2026-07-18

The Dependencies overview still inherited its architecture from the bounded
1,000-node representative sample. That made the picture stable and cheap to
paint, but domain size and cross-domain traffic could be understated whenever
their supporting symbols were outside the sample. The resulting constellation
also emphasized individual particles before it answered the project-scale
question: which code areas exist, and where does coupling cross their borders?

The layout response now includes one bounded `exact-domain-dependencies-v1`
atlas computed inside the same revision-stable SQLite snapshot as the sampled
graph. It ranks at most 12 real architecture domains, scales their circle areas
with a bounded square-root rule, and aggregates exact directed relation counts
by source, target, and type. Traffic between a retained domain and an omitted
domain remains included in that retained domain's inbound/outbound totals; no
synthetic external circle or invented relation is painted. Coverage metadata
states whether all domains and nodes fit inside the bounded atlas.

Canvas reuses the existing batched directed-bundle renderer for these weighted
flows. At macro scale it skips raw symbol fill, hit testing, and labels; semantic
zoom progressively hands control back to the already loaded representatives.
`D` browses exact domains, `Enter` opens the matching sampled domain by stable
key, and `N` becomes available after the representative layer is readable. A
browser regression found and closed a numeric-id collision where atlas `v2`
could select sampled `(root)`; the integration test now locks the key-based
resolution.

On the local 10,621-node index, the packaged endpoint returned all **7 / 7**
domains, exact totals for all **10,621** nodes, and **1,021** cross-domain
relations while retaining the 1,000-node interactive sample. Five local smoke
requests measured **369.4 / 391.7 / 535.5 ms** minimum/median/maximum; these are
single-machine observations, not V1/V2 benchmark claims. The visible packaged
site was checked at 836x958, 1024x768, and 1440x900 with no document overflow,
console warning, or console error. Keyboard domain drill-down and semantic zoom
were exercised against the real project.

Frontend **23 files / 216 tests**, the focused V2 layout suite **6 tests**, both
typechecks, the production build, and `build:package` pass. The unchanged gzip
limits remain green at Graph **38.81 / 40 KiB**, manifest CSS **14.84 / 15
KiB**, and manifest JavaScript **124.89 / 125 KiB**.
