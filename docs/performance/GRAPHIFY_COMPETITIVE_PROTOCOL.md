# Ariad versus Graphify competitive truth protocol

> **Status:** Canonical pre-registered benchmark protocol
> **Audience:** Maintainers, performance engineers, product reviewers, and auditors
> **Last verified:** `0.78.0-alpha.1` / 2026-07-23 at `0789b301`
> **Benchmark ID:** `r184-ariad-vs-graphify-2026-07-23`

This protocol freezes R184 before any scored competitive run. Its purpose is
not to manufacture a winner. It tests whether Ariad, Graphify, Graphify plus
Obsidian, or optimized source inspection supplies the most useful and
economical evidence for safe code changes.

The machine-readable authority for pins, exact questions, answer keys, arm
order, and output contracts is
[`scripts/benchmark/r184-graphify-competitive/spec.json`](../../scripts/benchmark/r184-graphify-competitive/spec.json).
The visual task authority is
[`visual-tasks.json`](../../scripts/benchmark/r184-graphify-competitive/visual-tasks.json).
The verifier rejects drift between those files, this protocol, the fixture,
and the pinned external checkouts.

No product correction may be selected from competitive results until the
baseline artifacts have been completed, checksummed, summarized, and sealed.
Preflight is limited to validating installation, command syntax, MCP startup,
fixture compilation, artifact routing, and grading mechanics. Preflight output
is never scored.

## 1. Question and claim boundary

R184 asks:

> For fixed code-change preparation tasks on one controlled fixture and three
> pinned real repositories, how do optimized source inspection, Graphify,
> Graphify plus Obsidian, and Ariad compare when task wording, source revision,
> model, reasoning effort, stopping rules, and grading are held constant?

The benchmark measures:

- exact task success;
- native input, cached-input, output, and total tokens;
- completed evidence-tool calls;
- fallback source reads and which evidence surface caused the answer;
- wall time and time to first useful evidence;
- cold indexing and official incremental-update time;
- peak process memory and generated artifact size;
- stale, incomplete, ambiguous, and truncated evidence handling;
- visual task success, actions, context loss, runtime cost, and errors.

It does not measure coding quality after an edit, hosted-team features,
unconfigured semantic-media backends, popularity, stars, or community size.
A result on one task family is never generalized to all code intelligence.

The previous Codebase Memory V1 study remains historical context. V1 is not a
fifth arm and is not rerun in R184.

## 2. Frozen product and competitor pins

| Component | Frozen value |
|---|---|
| Ariad baseline | `0789b3019d1847605ebe60a3be6abd16363249fe` |
| Ariad package | `0.78.0-alpha.1` |
| Graphify package | `graphifyy==0.9.25` with the `mcp` extra |
| Graphify release commit | `2fa6cd3d5548577f8c5f591b713f0bf80c1af183` |
| Graphify wheel | `graphifyy-0.9.25-py3-none-any.whl` |
| Graphify wheel SHA-256 | `e902205873d129e9c76c11fea4268480042603590290ed600707354e74314c0c` |
| Graphify license | MIT |
| Graphify Python | CPython 3.11 in an external virtual environment |
| Query agent | Codex CLI `0.144.4` |
| Query model | `gpt-5.6-sol`, reasoning `medium` |
| Node.js / npm | captured for every repetition; initial pin `v24.15.0` / `11.12.1` |

Graphify was inspected only to validate its public CLI, MCP, incremental
update, HTML, and Obsidian workflows. No Graphify implementation or visual
design is copied into Ariad. The competitor remains outside the Ariad
dependency graph.

Graphify code graphs use its deterministic local code extraction. R184 does
not spend an unapproved external-model budget on Graphify's optional semantic
document extraction. This does not remove documents from its intended
workflow: the Graphify arm may use focused source-document reads, and the
Graphify plus Obsidian arm receives the equivalent committed human notes in
its isolated vault. The report must state this boundary.

## 3. Filesystem and repository isolation

Let `$LAB_ROOT` be an operator-selected directory outside the Ariad checkout.
All of the following remain below that external root:

- Graphify virtual environments and downloaded wheels;
- competitor clones;
- controlled-fixture run copies;
- Graphify outputs and caches;
- Ariad `XDG_CACHE_HOME` state;
- Obsidian vaults;
- mutable edit/rename/delete targets;
- raw JSONL, prompts, traces, screenshots, videos, and profiles.

The Ariad checkout must never contain `graphify-out`, competitor clones,
benchmark databases, vaults, Python environments, raw model logs, or
machine-specific absolute paths. Graphify install, hook, watch, global, and
Codex-instruction commands are forbidden. In particular, Graphify must not
modify `AGENTS.md`, `.codex`, Git hooks, user configuration, or the operator's
global Python environment.

Every external Git target must be detached at its frozen SHA and clean before
indexing and before each immutable run copy is made.

## 4. Frozen corpus

| ID | Role | Repository / source | Exact revision | License |
|---|---|---|---|---|
| `fixture` | Controlled aliases, routes, notes, bounds, and mutation | [`v2/tests/fixtures/r184-competitive-lab`](../../v2/tests/fixtures/r184-competitive-lab/) | R184 preregistration commit | Ariad fixture |
| `p-limit` | Small JavaScript | <https://github.com/sindresorhus/p-limit> | `df476048d023ff868cd45b35ee47f5fb0ca2b25a` | MIT |
| `zod` | Medium TypeScript monorepo | <https://github.com/colinhacks/zod> | `912f0f51b0ced654d0069741e7160834dca742ee` | MIT |
| `fastapi` | Large non-TypeScript project | <https://github.com/fastapi/fastapi> | `704fbe1439341994100622853f515a8af7ccc2eb` | MIT |

No target may be replaced or excluded after results are visible. A platform
failure is a result unless the frozen exclusion rule below applies.

The controlled fixture contains:

- a TypeScript interface with an alias and renamed re-export;
- direct and transitive type uses across architecture domains;
- an exact `POST /pipeline/run` entry to a terminal durable write;
- four callers of one shared checkpoint for bounded-output testing;
- equivalent ADR and active-risk Markdown notes;
- an obsolete file for deletion testing;
- deterministic mutation inputs for edit, rename, addition, and deletion.

The fixture answer key lives outside the fixture directory so an agent working
on its isolated copy cannot discover expected output.

## 5. Frozen arms

### A — optimized source

Permitted evidence is limited to `rg`, `rg --files`, focused PowerShell
`Get-Content`, `Select-String`, and `Select-Object` used only to bound a focused
read. No graph, generated report, Git history, language server, custom
answer-computing script, web lookup, or write is allowed.

### B — Graphify hybrid

Use Graphify MCP first for structural questions. Focused operations from arm A
are allowed for exact source lines, documents, or a graph miss. The run records
whether Graphify evidence was actually used. Git, web, other graphs, writes,
and generated answer scripts remain forbidden.

### C — Graphify plus Obsidian hybrid

Use the same Graphify graph as arm B plus Graphify's deterministic Obsidian
export. The two committed fixture notes are copied unchanged into the isolated
vault; their code wikilinks and paths provide the same human facts available
to Ariad. Vault search/read, Graphify MCP, and focused source fallback are
permitted and separately counted.

### D — Ariad hybrid

Use Ariad's bounded read-only MCP operations and linked human memory for
structural and decision evidence. Use the cheapest exact source operation for
literal or known-path evidence. Write MCP tools, Git, web, other graphs, and
answer-computing scripts are forbidden.

A run is not credited as graph-caused when its trace contains no relevant
graph evidence. Source-only success remains valid task success but is reported
as source-caused.

## 6. Frozen tasks

The exact prompts and answers are in `spec.json`. The families are:

| Task | Target | Required capability |
|---|---|---|
| T01 | `p-limit` | Direct and bounded transitive callers |
| T02 | fixture | Alias- and re-export-aware type impact |
| T03 | fixture | HTTP route to terminal implementation |
| T04 | `zod` | Cross-domain dependency with copy-ready evidence |
| T05 | fixture | Linked ADR, risk, ownership, and constraints |
| T06 | `fastapi` | Minimum sufficient edit context |
| T07 | fixture | Explicit completeness and truncation under a bound |
| T08 | mutated fixture | Fresh edit, rename, addition, and deletion result |
| T09 | fixture UI | Domain to symbol to dependency to restored context |
| T10 | `zod` UI | Product-scale dependency navigation and narrow recovery |

T08 uses a fresh copy of the baseline fixture. The registered mutation:

1. renames `src/delivery/publish.ts` to `src/delivery/commit.ts`;
2. updates the orchestration import;
3. adds `src/monitoring/audit.ts` as a new direct caller;
4. deletes `src/legacy/obsolete.ts`;
5. runs each product's official incremental update exactly once.

The mutation manifest and replacement sources are committed under
[`mutation/`](../../scripts/benchmark/r184-graphify-competitive/mutation/).

## 7. Mechanical grading

Each answer is normalized by:

- converting CRLF to LF and `\` paths to `/`;
- removing outer whitespace and one outer Markdown fence;
- parsing required JSON;
- sorting only fields whose prompt explicitly declares set semantics.

The grader never repairs an identifier, line, missing element, malformed JSON,
or unsupported inference.

Atomic elements are scalar values, JSON leaves, set members, and ordered chain
steps.

- `PASS`: exact normalized answer.
- `PARTIAL`: no wrong extra element, at least half of expected atomic elements
  are correct, and retained chain steps preserve order.
- `FAIL`: any wrong extra element, fewer than half the elements, wrong chain
  order, malformed required output, refusal, timeout, runtime failure, or no
  answer.

A forbidden evidence operation invalidates the first attempt. The invalid
artifact remains immutable and disclosed; one clean rerun is allowed. A second
violation is `FAIL`. There is no discretionary semantic judge for T01–T08.

## 8. Agent execution and native accounting

Cold mode runs every task in a fresh ephemeral read-only Codex process. Warm
mode runs T01–T08 sequentially in one arm-specific conversation so accumulated
context is measured rather than hidden.

Each mode uses four repetitions and the frozen Latin-square arm order in
`spec.json`. Task order never changes. All arms use the same model, reasoning,
checkout revision, task text, output contract, project-document byte limit of
zero, and approval policy `never`.

Native JSONL is authoritative. Record:

- `input_tokens`;
- `cached_input_tokens`;
- `output_tokens`;
- `total_tokens = input_tokens + output_tokens`;
- completed evidence-tool calls by tool and family;
- final answer;
- wall time;
- time from process start to the first completed evidence item;
- exit and timeout status.

Do not estimate absent token fields from characters, tokenizer libraries,
prices, or another runtime. Missing native usage makes the cell `NOT
FEASIBLE`, not zero.

The audit must flag shell commands outside the allowed operation set, source
reads in an MCP-only evidence step, writes, Git, web, unexpected MCP servers,
and Ariad write tools.

## 9. Index, update, and artifact measurements

Indexing is outside query-token totals but remains a scored product cost.
Capture at least four clean cold builds and four official incremental no-change
updates for each indexed target and product. T08 additionally captures the
registered change update.

For every index/update run record:

- exact command and environment;
- exit code and wall time;
- process peak working set where the platform exposes it;
- input file count, indexed node count, relationship count, skipped files,
  errors, and completeness signals;
- generated artifact bytes;
- repository status before and after;
- SHA-256 of the graph or database artifact.

On Windows, Graphify's virtual-environment executable is a redirector. Peak
working set therefore sums the isolated redirector and base-interpreter
processes by their exact executable paths every 100 ms. The runner refuses a
sample when another Python process with either path already exists. Ariad's
Node process is sampled directly. Sampler shutdown time is excluded from
product wall time.

Graphify uses `extract --code-only` for a clean graph, `update` for the
registered mutation, `export html` for UI, and `export obsidian` for arm C.
Ariad uses its default correctness-first full index and `--incremental` for
updates. Reduced-coverage fast mode is forbidden.

## 10. Human-memory equivalence

The fixture ADR and risk note are the single factual source for T05.

- Arm A reads the committed notes.
- Arm B may read those same committed notes after a graph query.
- Arm C receives byte-equivalent notes in its isolated Obsidian vault, next to
  Graphify-generated code notes.
- Arm D imports byte-equivalent notes into an isolated Ariad human database
  and links them to the exact indexed code nodes represented by the same
  wikilinks.

No arm receives an extra fact, answer summary, hidden alias, or private
operator note.

## 11. Graph UI protocol

T09 and T10 are task measurements, not screenshot voting. The initial capture
must happen before pan, zoom, search, selection, filtering, or Fit.

For each target and viewport:

1. preflight the exact selected target and actual rendered topology;
2. record the requested layout URL or graph artifact;
3. capture the initial frame;
4. blind the A/B identity with the frozen seed;
5. complete the task sheet before opening the key;
6. record task success, time, actions, and context-loss events;
7. capture first usable render, FPS, long tasks, idle CPU, and heap;
8. record console, page, HTTP, clipping, overlap, and accessibility failures.

Desktop is `1920×1080`; narrow is `380×958`. Both native extraction
differences remain visible. Missing nodes or edges are findings and are never
normalized away.

Graphify's native HTML and Ariad's packaged Graph UI are compared as shipped.
The benchmark must not patch, restyle, inject labels into, or rehost either
renderer in a way that changes its product behavior.

The UI matrix uses five cold and five warm measurements for every product,
target, and viewport. A cold measurement creates a fresh browser context and
clears its browser cache while the product server remains stable. A warm
measurement reuses one product-and-viewport browser context after one
unscored prime. This separates browser/cache cost from process-start noise.
Run order alternates by repetition.

The Graphify HTML file is served byte-for-byte by a read-only loopback static
server. Its pinned `vis-network@9.1.6` CDN request, integrity check, success,
failure, and transfer behavior remain part of the native result. Ariad runs
the packaged UI against the exact isolated database created by repetition
four. The browser must prove that Graphify's embedded node/edge payload and
Ariad's requested project, total node count, layout response, and canvas
identity match their selected artifacts before a sample is valid.

T09 and T10 fail closed against the mechanical signals registered in
`visual-tasks.json`. Merely finding a similarly named item does not prove
dependency direction, exact evidence, restored context, or an unclipped
narrow recovery. The blind task sheet contains only deterministic A/B labels;
the key is a separate artifact and is opened only after reviewing the sheet.
Native logos, product wording, and product-specific controls are not masked,
because masking them would change the shipped interface. Consequently this is
an A/B key blind, not a claim of double-blind perception.

## 12. Baseline seal and correction selection

The baseline is sealed only after:

- every required cell exists or has an explicit failure artifact;
- raw prompts, JSONL, stderr, MCP traces, metadata, captures, and profiles have
  SHA-256 entries;
- the environment manifest proves pins and target cleanliness;
- the mechanical grader and summary tests pass;
- a baseline seal file names the preregistration and result-manifest hashes.

Only then may diagnosis rank losses by correctness, evidence quality, user
value, token/call cost, architectural fit, and regression risk.

Accept at most the smallest set of high-impact root-cause changes supported by
the baseline. Every practical bug fix begins with a failing regression. Do not
add panels, labels, schemas, caches, animations, dependencies, or abstractions
merely to mimic Graphify or win a screenshot.

The post-fix run uses the unchanged tasks, answers, corpus, arm order, model,
grading, and exclusion policy.

## 13. Interpretation

Ariad wins a task family only when:

1. its task success meets or exceeds the best other arm;
2. evidence is at least as exact and auditable;
3. stale, ambiguous, incomplete, or truncated states remain visible;
4. any token, call, latency, or UI advantage repeats across the frozen runs;
5. the result survives cold and warm modes where applicable;
6. no material correctness, platform, package, UI, or maintenance regression
   appears.

The final report separates wins, ties, losses, and unsupported conclusions.
It must say where Graphify remains stronger. “Ariad beats Graphify” is
forbidden unless every named scope is explicitly bounded by measured task
families and repositories.

## 14. Executable sequence

All commands below run from the Ariad checkout. `$LAB_ROOT` is an external
directory and `$PREREG_SHA` is the full Git SHA that first commits this frozen
protocol and harness.

```text
node scripts/benchmark/r184-graphify-competitive/verify-spec.mjs
node scripts/benchmark/r184-graphify-competitive/capture-environment.mjs --lab-root $LAB_ROOT --phase baseline --prereg-sha $PREREG_SHA --output $LAB_ROOT/results/baseline/environment.json
node scripts/benchmark/r184-graphify-competitive/measure-index.mjs ...
node scripts/benchmark/r184-graphify-competitive/prepare-query-state.mjs --lab-root $LAB_ROOT --phase baseline --output $LAB_ROOT/results/baseline/query-preparation.json
node scripts/benchmark/r184-graphify-competitive/run.mjs verify --lab-root $LAB_ROOT --phase baseline --prereg-sha $PREREG_SHA
node scripts/benchmark/r184-graphify-competitive/run.mjs run ...
node scripts/benchmark/r184-graphify-competitive/summarize.mjs --results-root $LAB_ROOT/results/query --phase baseline --output $LAB_ROOT/results/baseline/query-summary.json
node scripts/benchmark/r184-graphify-competitive/visual-lab.mjs --lab-root $LAB_ROOT --phase baseline --output $LAB_ROOT/results/baseline/visual
node scripts/benchmark/r184-graphify-competitive/seal-results.mjs --lab-root $LAB_ROOT --phase baseline --prereg-sha $PREREG_SHA
```

The index and query runners intentionally require one explicit matrix cell or
repetition at a time. They refuse to overwrite an existing artifact. The seal
fails unless all 64 cold/no-change index cells, both registered mutation
updates, all 256 agent-task cells, and all 80 visual samples exist. Raw
evidence remains outside Git; the repository receives only bounded reports,
tables, hashes, and documented conclusions.

## 15. Publication gates

Before publication:

- run the targeted benchmark tests and regressions;
- run backend install, docs, typecheck, build, package build, audit, and
  relevant Vitest suites;
- run frontend install, typecheck, build, bundle budget, audit, and all tests;
- run packaged desktop and narrow browser smoke with zero unexpected console,
  page, or HTTP errors;
- verify Windows behavior and embedded UI integrity;
- review the full diff for competitor artifacts, databases, vaults, secrets,
  raw logs, generated graphs, and absolute machine paths.

The PR must include the frozen protocol, selected bounded evidence,
root-cause diagnosis, corrections, tests, truthful limits, and exact
verification links. Merge only the verified head. After merge, local and
remote feature branches are deleted, exact local `main` equals
`origin/main`, and the packaged local Graph UI is relaunched from that commit.
