# Graph UI Performance & Perception Lab

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

The reference source is MIT licensed but is not vendored a second time into
this repository. A local clone/build belongs in the ignored
`.codex-runtime/graph-ui-lab/v1-source` directory.

## The strict same-graph rule

For a strict renderer comparison:

- V1 creates one database from the chosen fixture;
- the V1 and V2 servers open byte-identical snapshots of that database;
- `/api/layout` must return every node on both sides;
- sorted node IDs and sorted `(source, target, type)` edges must have identical
  SHA-256 fingerprints.

The runner stops before launching a browser if either response is sampled or a
fingerprint differs. `--allow-sampled` exists only for an explicitly labelled
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

## Local evidence — 2026-07-17

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
