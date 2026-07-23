# V2 Architecture — Codebase Memory V2

> **Status:** Canonical architecture
> **Audience:** Contributors, maintainers, integrators, and auditors
> **Last verified:** `0.78.0-alpha.1` / 2026-07-23
>
> R169A and R169B are merged;
> R169B is on `main` at
> `15a732d91984e5b4ffa29b4e129ac0d6316c9fca`.
> **Activation boundary:** the generation-store resolver, publisher, CAS,
> GC, and recovery primitives are MERGED / INACTIVE. The production indexer,
> readers, UI, MCP, and CLI still write or open the legacy `<project>.db`
> through `defaultCodeDbPath`. R169C+ integration/activation is future work,
> so `DATA-CARRY-01` remains open.

## 1. System Context

Codebase Memory V2 is a hybrid code intelligence system that combines:

- A **native WASM indexer** (112 languages via tree-sitter) that builds a
  code graph in SQLite without requiring a C engine.
- A **human memory graph** (SQLite) for notes, ADRs, and Obsidian sync.
- An **MCP server** exposing 8 tools for code graph queries and human
  memory CRUD.
- A **web-based graph UI** (React/Vite) served by the V2 backend.

The V1 C engine is retained as a **reference and optional separate database
producer**. V2 never launches V1 as a fallback. If an operator runs V1
separately, `CodeGraphReader` can consume the compatible `<project>.db` it
produced.

## 2. Monorepo Components

```
v2/             Core: CLI, indexer, MCP, human memory, UI server
graph-ui/       Frontend: React/Vite graph visualization
v1-reference/   Historical C engine (reference + separate DB producer)
scripts/ci/     Infrastructure automation (mirror state machine)
docs/           Documentation
```

## 3. V2 Native WASM Indexer

The indexer does NOT require V1. It uses tree-sitter WASM parsers to
extract:

- **Exports** (functions, classes, types, constants)
- **Imports** (named, default, namespace)
- **Call sites** (function/method calls with resolved targets)
- **Aliases** (symlinks, path mappings)

Key modules:
- `v2/src/indexer/wasm-extractor.ts` — tree-sitter WASM parsing, discovery
- `v2/src/indexer/fast-walker.ts` — AST walker for exports/imports/calls
- `v2/src/indexer/cross-file-resolver.ts` — matches call-sites to definitions
- `v2/src/indexer/indexer.ts` — orchestrator: full/incremental, parallel workers
- `v2/src/indexer/schema.ts` — SQLite schema, `CURRENT_EXTRACTOR_SEMANTICS_VERSION = 8`

## 4. V1 C Engine — Separate Producer/Reference

The V1 C engine (`v1-reference/`) can be run separately for:
- Its 158-language coverage and V1-grade precision
- Performance comparison benchmarks
- Historical reference

V2 detects only the resulting `<project>.db`, not a V1 executable, and can
use that database as a read-only code graph source via the bridge module.
There is no automatic V1 invocation or indexer handoff. V2 can instead write
the code graph independently with its native indexer.

## 5. SQLite Code Graph

The code graph is stored in a SQLite database (`<project>.db`) with:

- `nodes` — exported symbols (functions, classes, types)
- `edges` — call relationships (caller → callee)
- `file_hashes` — file content hashes for incremental indexing
- `projects` — project metadata (root path, fingerprint, stale flag)
- `alias_history` — historical alias targets for protection

Schema version: `CURRENT_EXTRACTOR_SEMANTICS_VERSION = 8`
Discovery policy version: `CURRENT_DISCOVERY_POLICY_VERSION = 3`

## 6. Human Memory Graph

A separate SQLite database (`<project>.human.db`) stores:
- Notes with labels (decision, risk, question, etc.)
- ADRs (Architecture Decision Records)
- Links to code graph nodes
- Obsidian frontmatter sync

## 7. Obsidian Integration

V2 syncs human memory to/from Obsidian vaults:
- **Generator**: writes human memory nodes as Markdown files with frontmatter
- **Importer**: reads Obsidian files back into the human memory graph
- **Wikilinks**: resolves `[[note]]` references
- **Path safety**: validates against path traversal attacks
- **Portable identity**: vault traversal normalizes relative paths to `/`
  before persisting or comparing `obsidian_path`, including on Windows

## 8. MCP Server

The MCP (Model Context Protocol) server exposes these 8 tools:

1. `get_project_overview` — summarize graph, human-memory, coverage, and freshness state
2. `get_module_context` — return code and human context for one module or file
3. `get_undocumented_hotspots` — rank critical code nodes without documentation
4. `create_human_note` — create a human-memory note and optionally link code nodes
5. `link_note_to_code_node` — link an existing note to an existing code node
6. `search_code_and_memory` — search the code graph and human memory together
7. `lookup_source_text` — bounded exact literals, TypeScript type dependents, identity-aware direct/multi-hop callers, route/CLI call chains, and tracked inventory
8. `prepare_edit_context` — assemble dependency, risk, freshness, and note context before editing

Obsidian synchronization is a separate CLI/watch responsibility; none of the
eight MCP tools is a vault-sync command.
The stdio server negotiates MCP `2025-11-25`, `2025-06-18`, or legacy
`2024-11-05`, rejects JSON-RPC batches, and keeps `tools/call` closed until a
standalone initialize request is followed by `notifications/initialized`.
Bounded coverage responses label partial scans and lower-bound counts instead
of presenting the sampled portion as exact project-wide state.

`lookup_source_text` is one backward-compatible exact-evidence gateway rather
than four independently advertised schemas. Its default literal contract is
unchanged. Optional profiles aggregate persistent call-sites, follow exact
TypeScript symbol identities through a bounded reverse multi-hop call graph,
compute alias-aware transitive type dependents from one exact declaration,
read Git-tracked inventory, or trace a shortest static chain from an exact
route/CLI entry. The semantic profiles load the TypeScript compiler
only when `max_depth > 1`; the chain profile loads one bounded production
call-site map, uses reverse reachability only to prune name ambiguity, and
verifies every forward hop from a call-site or bounded source expression. All
profiles expose explicit completeness and caps.

## 9. Graph UI

A React/Vite application (`graph-ui/`) served by the V2 backend:

- **Dashboard** — project KPIs, graph freshness, and recommendations
- **Graph** — force-directed d3 visualization, filters, sidebar, and node details
- **Projects** — project selector with graph counts and health indicators
- **Control** — system information, logs, and owned index-job controls
- **Real-time updates** via WebSocket where the active view requires them

The Graph tab has one topology, one d3 simulation object, and one interaction
model. The user-facing views are `Structure` and `Dependencies`; the persisted
internal values remain `architecture` and `stellar` so existing preferences do
not require a migration. `Structure` is the default and follows the
server-authored domain/community anchors. At macro scale it labels only the 12
largest communities whose projected circles can carry text, using the existing
collision budget. `Dependencies` installs deterministic targets into that same
  simulation. Without a focus, an exact domain dependency atlas replaces the
  representative particle frame. Hover or keyboard domain focus emphasizes
  one bounded scope; activating it opens the sampled domain and its existing
  exact-scope action. Zoom progressively reveals the representative
  constellation, where node hover or
  virtual keyboard focus adds a read-only first-hop paint lens. That lens traces
  at most two incident edges per semantic group from topology already loaded in
  the Canvas, adds direction markers and a focus ring, and never changes d3
  coordinates, filters, navigation, or network state. Pointer focus is
  invalidated on semantic-frame and server-revision changes; keyboard focus
  remains the intentional fallback. Selecting a visible symbol pins it to
  the semantic origin, unfolds up to four visible incoming relation layers to the left and
outgoing layers to the right, and retains unrelated symbols as dim outer
context. Numbered rails come only from real directed paths. Repeated directory
lanes receive a bounded module label; direct and transit edges share one
  five-group color/dash grammar, and a focus-only Canvas label lists visible relation
  groups incident to the selected node. Incoming labels prefer left-facing anchors,
outgoing labels prefer right-facing anchors, and each has two deterministic
vertical fallbacks before omission. Exact degree still selects the V1 reference spectral scale, node type
selects a circle/diamond/square glyph, and only the selected flow receives
direction markers. Status remains an outer stroke. Invalid or unavailable local
storage falls back to `Structure`.

`Structure` uses progressive domain focus rather than another overlay or
renderer. Pointer hover and keyboard domain browsing share one focused-scope
paint path. The active domain receives the existing semantic fill/stroke and
its related bundles retain priority; community caption candidates are limited
to that domain while other domain titles remain as orientation anchors. Its
summary uses the exact top-level catalog when available. Idle rendering is
unchanged, and the lens adds no per-node paint pass or simulation mutation.

`GET /api/layout` derives the unfocused dependency atlas inside the same stable
SQLite snapshot as the representative topology. It ranks at most 12 domains by
exact node/file count, applies a bounded square-root area scale, and uses the
shared deterministic circle packer. One grouped SQL read aggregates every edge
touching those domains. Selected-to-selected relations remain exact typed
bundles; selected-to-omitted relations contribute to exact in/out totals but do
not create a false `(other)` node. The contract separately reports complete or
partial domain/node coverage.

At the atlas camera, representative nodes, their raw edges, labels, previews,
and hit targets are skipped. The Canvas paints domain surfaces, four traffic
tiers, collision-checked exact summaries, and at most 28 directed bundles.
Zoom performs a quiet semantic handoff to the existing symbol constellation;
domain scopes stop intercepting input before symbol hit targets become active.
Domain and relation filters reuse the layout response, so no additional request,
full-graph client scan, renderer, or simulation is introduced.

The focused camera is composed from directed targets only; the 1,000-node dim
context cannot shrink the active neighborhood. Screen-space safe insets reserve
the fidelity HUD, action rail, guide, breadcrumb, and label overhang. A
`ResizeObserver` recomposes an untouched focus after viewport or panel changes
without reheating the simulation. Depth one keeps the full lane separation;
depths two through four advance monotonically with stronger sublinear spacing.
Moderate fan-outs use up to 60 world units between rows, while very large
fan-outs retain the existing 760-unit vertical cap. This balances the directed
frame before the camera fit instead of hiding nodes or applying a non-uniform
transform. Labels are ranked once per semantic-frame change, receive a
viewport-derived bounded budget, and are omitted before they can cross the safe
screen rectangle. Selection, keyboard focus, and the transient Dependencies
preview enter the placement queue first. A collision consumes no paint slot:
the pass continues through at most four budget windows and never beyond 96
candidates. Structure symbols use the same three outside-first anchors as
directed flow labels; only the direction policy differs. This backfills useful
labels without scanning the complete graph, mutating d3, or introducing a
per-frame optimizer.

This boundary is deliberate: changing task view reuses every d3 node object,
event listener, exactness contract, and canvas allocation. A view/focus change
receives one bounded simulation reheat; known filter subsets and restorations
remain settled. Sampling, exact values, filtering, navigation, accessibility,
and detail logic are not forked. The active focus alone is fixed at `(0,0)` and
is released when selection or mode changes, preventing high-fan-out link forces
from moving the semantic origin. Hub bloom, orbit guides, depth rails, and the
focused flow axis are batched Canvas paths; there are no shadows, per-node gradients,
Three.js scene, WebGL backend, or second layout engine. The Graph application
chunk remains protected by its 39 KiB gzip budget; the stable `d3-*` force stack
is cached separately and both remain covered by the 123 KiB manifest-wide
JavaScript budget. Multi-pass Terser compression preserves real transfer
headroom rather than weakening either limit.

The bounded overview is followed by a revision-bound exact drill-down rather
than a second renderer. `GET /api/scope` keyset-pages a domain, a semantic
community, or a filesystem directory subtree. A node batch owns every internal
edge whose highest-id endpoint it
introduces; edge-only continuation pages drain dense batches before the node
frontier advances. This makes page merging duplicate-free and prevents a page
from referencing a node the client has not loaded. The UI renders the merged
frame in the existing `GraphCanvas`/d3 simulation with raw topology enabled,
labels partial versus complete truth, re-fits only at the overview/detail frame
boundary, and restarts from page one on `GRAPH_REVISION_MISMATCH`. The read-only
bridge derives all domain/community memberships in one node pass per graph
revision. Directory membership is deliberately separate: an explicit tree
drill-down performs a portable slash/backslash prefix query, validates the
node's semantic directory, and stores at most 24 revision-bound memberships in
LRU order. This avoids both the former key collision with a homonymous
community and an eager full-project descendant map. Selecting a community or a
non-domain tree path enables the exact page immediately; continuation and edge
membership stay in SQLite through a materialized `json_each` CTE.

The exact scope is not laid out as one uniform symbol disk. Once per cached
membership, the read bridge derives a deterministic `exact-directory-file-v1`
plan from all exact nodes. Immediate directories become domains, files become
communities, and symbols keep a stable hash-derived position inside their file.
The plan is bounded to 12 directory surfaces and 48 selected files, with at
most one `(other files)` aggregate per directory (60 file surfaces maximum).
Counts are explicitly `all_nodes`; the Canvas therefore paints the complete
bounded architecture even when the first page contains only 125 symbols. This
uses the existing domain/community paths, collision packing, Canvas, and d3
simulation. It adds no renderer, per-paint graph scan, eager descendant index,
or extra frontend request.

Symbol selection is local to this exact frame. `GraphTab` resolves the selected
node from the active exact page, preserves the scope request and breadcrumb,
and derives the highlighted neighborhood from the currently merged exact
nodes/edges. It does not rebuild overview navigation or fall back to sampled
layout data while the detail panel is open. The complete directory/file
surfaces remain visible as architectural context, but keyboard domain/community
browsing includes only surfaces that contain loaded symbols; this prevents an
unloaded file group from becoming an empty zoom target.

Path explanation is a separate explicit read, not another visualization mode.
`GET /api/path` opens one stable graph snapshot and runs a deterministic,
edge-id-ordered breadth-first search across inbound and outbound relationships.
This undirected traversal answers architectural coupling while the returned
edges retain their stored direction and type. The default depth is six hops;
the public maximum is eight, with hard ceilings of 5,000 visited nodes and
20,000 inspected edges. `found` and exhausted `not_found` results are exact.
`max_hops` and `limit_reached` are deliberately incomplete and the client says
so instead of turning a safety stop into a false disconnection. The Graph UI
starts no request until the user chooses `Trace connection from here` and then
reuses the existing exact project search to select the target.

The UI is built and embedded in the npm package at `dist/ui/`. Runtime
resolution uses `import.meta.url` so it works from any working directory.
The browser bundle targets ES2022, matching its TypeScript contract and the
documented Chromium-family local runtime. Tailwind v4 receives an explicit
semantic color mapping, so `foreground`, `primary`, `accent`, `border`, and
related opacity utilities are present in production CSS rather than silently
discarded. Static node-detail and graph-control styles remain in CSS to protect
the JavaScript transfer budget. Radix components import only the direct Slot,
Checkbox, ScrollArea, and Separator packages. The aggregate `radix-ui` entry
point is forbidden in production source and the build checks GraphTab's source
map against the transitive closure of its allowed Radix roots, preventing a
dependency patch from silently bundling unrelated primitives.
The loopback server keeps an idle LRU budget of four project-store entries;
code and human SQLite connections use 64 MiB and 8 MiB page-cache ceilings.
Control browsing/indexing is confined to the user's home directory, the
selected project's canonical indexed root, and explicit
`ui --allowed-root <paths...>` additions.
Shutdown has one global deadline across transports, stores, and owned indexers;
on Windows, `taskkill /T` uses the remaining deadline after escalation rather
than a separate 250 ms cutoff that could orphan descendants.

## 10. Publication: active product versus merged primitives

### Current state

The indexer writes to the active SQLite database in stages:
1. Clear old data (`clearProjectData`)
2. Insert nodes
3. Insert edges
4. Insert file hashes
5. Update project metadata

A crash between steps can leave a partial graph. The `stale` flag and
`alias_history` table provide some protection, but the publication is
not atomic.

### Merged R169A/R169B primitives (inactive)

R169A provides the path, manifest, fail-closed resolver, and atomic JSON
foundation. R169B provides reserve, prepare/WAL finalization, validation,
fd-based copy+hash promotion, temp fsync, no-clobber `link`, metadata,
manifest, CAS, GC, and recovery primitives. The publication entry point is
`publishPreparedGeneration`; it is independently tested but has no
production indexer caller.

The DB promotion is not a rename from `tmp/`. It copies and hashes the
authenticated staging fd into an exclusively created temp in
`generations/`, fsyncs that fd, then links the temp to the final generation
name without clobbering. Metadata and DB are verified before the manifest
is atomically replaced.

### Future activated contract

```
reader sees:
  old complete snapshot
  OR
  new complete snapshot
  never a partial publication
```

Architecture: immutable generation DB + atomic manifest replacement + CAS +
authenticated GC/recovery. R169C integrates the indexer, R169D cuts over
readers/lifecycle, and R169E performs the integrated activation gates.

## 11. CI / Mirror

- **GitHub** is the canonical repository (source of truth, CI, PRs, merges)
- **GitLab** is a passive mirror of `main` only (no pipelines, no MRs)
- **Mirror workflow** (`mirror-main-to-gitlab.yml`) triggers on CI success
  via `workflow_run`, fast-forwards the validated SHA to GitLab with
  `-o ci.no_pipeline`
- **Mirror state machine** is in `scripts/ci/mirror-main-to-gitlab.sh`
  (testable with bare repos)

See [GITHUB_GITLAB_BRANCH_BRIDGE.md](../operations/GITHUB_GITLAB_BRANCH_BRIDGE.md) for
the full architecture, postmortem, and diagnostic matrix.

## 12. Packaging

- **npm package**: `v2/package.json` with `files: ["dist", "README.md", "CHANGELOG.md", "LICENSE"]`
- **Build**: `npm run build:package` (via `scripts/build-package.mjs`)
  builds graph-ui + v2 backend + copies UI assets to `dist/ui/`
- **Docker**: 3-stage build (ui-builder → builder → runtime)
- **Lockfiles**: `v2/package-lock.json` + `graph-ui/package-lock.json`
  committed for reproducibility

See [RELEASE_POLICY.md](../operations/RELEASE_POLICY.md) for release governance.

## 13. Security

- SSH credentials: dedicated GitLab mirror key (not shared with GitHub)
- GitHub Actions: actions pinned by immutable SHA
- Dependabot opens bounded, grouped weekly minor/patch updates for GitHub
  Actions, backend, Graph UI, and Docker; semver-major version updates are
  ignored and remain deliberate migrations; every update still passes normal PR CI
- Branch protection: `main` protected, fast-forward only for mirror

## 14. Limitations

- Product publication remains non-atomic because the merged R169A/R169B
  generation primitives are not on the production path
- No project lease/fencing (R170 target)
- Node.js requirement: `>=22.12.0` (from `v2/package.json`). CI verifies the
  exact floor on Linux and Windows; development and Docker use Node 24 LTS.
- No GitHub Release yet (pre-release after R169 + R170)
- The canonical GitHub repository was renamed to `Cheurteenyt/Ariad`; active
  workflows, package metadata, and documentation are bound to that identity.

## 15. R169 Generation Store Architecture (MERGED / INACTIVE)

> **Status: R169A and R169B are merged; R169B is on `main` at
> `15a732d91984e5b4ffa29b4e129ac0d6316c9fca`. No production path uses
> the generation store.** The indexer still writes to the legacy
> `<project>.db` path and readers still open that DB directly. This
> section distinguishes the merged primitive contract from future product
> activation. `DATA-CARRY-01` (P1) remains open
> until R169E (after crash matrix + concurrency + performance +
> activation).

### 15.1 Goal

A reader of the code graph must see **either the old complete snapshot
or the new complete snapshot — never a partial publication**. This is
the contract that will close `DATA-CARRY-01` (P1) — but only once R169E
has replayed the C01–C20 crash matrix, completed the concurrency and
performance analysis, and passed the activation gating. R169B and R169C
are necessary preconditions; `DATA-CARRY-01` remains OPEN until R169E.

### 15.2 Storage layout

All generation-store data lives under the platform cache directory:

```
<XDG_CACHE_HOME or ~/.cache>/
└── codebase-memory-mcp/                       # cbmCacheDir()
    ├── <project>.db                            # legacy DB (current behavior)
    └── projects/                               # generationStoreRoot()
        └── <sha256(project)>/                  # projectStoreDir()
            ├── active-generation.json          # manifest (single pointer)
            ├── index-state.json                # diagnostics sidecar
            ├── generations/
            │   └── generation-<uuid>.db        # immutable published DB
            └── tmp/                            # staging area for new DBs
```

The project directory is named by `sha256(project)`, never by the
project name directly. This prevents path traversal, separator
injection, and length / Unicode issues. The original project name is
stored inside the manifest (`project` field) and validated against the
requested project on every read.

### 15.3 Manifest schema V1

`active-generation.json` is a JSON object with exactly these 13 keys:

| Key | Type | Constraint |
|---|---|---|
| `formatVersion` | integer | Must be `1`. |
| `project` | string | Must match the requested project exactly. |
| `generationId` | string | Canonical UUID v4. |
| `dbFile` | string | **Canonical form**: exactly `generations/generation-<generationId>.db` (matching the manifest's own `generationId`). Any deviation → `MANIFEST_DBFILE_NOT_CANONICAL`. |
| `createdAt` | string | ISO-8601 **with timezone**. |
| `rootFingerprint` | string | Non-empty. |
| `extractorSemanticsVersion` | integer | `>= 0`. |
| `discoveryPolicyVersion` | integer | `>= 0`. |
| `nodeCount` | integer | `>= 0`. |
| `edgeCount` | integer | `>= 0`. |
| `fileCount` | integer | `>= 0`. |
| `sizeBytes` | integer | `>= 0`. |
| `sha256` | string | 64 lowercase hex chars. |

The exact key set is enforced: missing or extra keys →
`MANIFEST_SCHEMA_ERROR`. A future incompatible change requires bumping
`formatVersion` and a migration plan. The current
`CURRENT_GENERATION_MANIFEST_VERSION = 1` is exported from
`v2/src/indexer/schema.ts`.

### 15.4 Publisher primitive state machine

```
RESERVE → POPULATE → PREPARE/WAL → VALIDATE → PROMOTE → VERIFY → MANIFEST → CAS COMMIT
```

- **RESERVE / POPULATE:** exclusively create
  `tmp/generation-<uuid>.db`; the future R169C caller populates it.
- **VALIDATE:** open the staging DB, run consistency checks (row counts,
  sha256, schema version, root fingerprint).
- **PREPARE/WAL:** checkpoint/truncate WAL, switch to DELETE journal,
  reject sidecars, fsync, validate, and seal the prepared token.
- **PROMOTE:** copy+hash through authenticated fds into an exclusively
  created temp in `generations/`; fsync it; no-clobber
  `link(temp, final)`; verify identity; fsync the directory; perform
  identity-checked cleanup.
- **VERIFY / MANIFEST:** atomically write metadata, verify the DB and
  metadata, then atomically replace `active-generation.json`.
- **CAS COMMIT:** update catalog, active ID, and publication history under
  `BEGIN IMMEDIATE`, then commit.

The DB is **fully written and fsynced** before the manifest is touched.
The manifest swap is the **only** generation-selection mutation visible to
future cut-over readers. This state machine is merged but not called by the
production indexer.

### 15.5 Durability ordering

For JSON metadata and manifest replacement, the internal atomic writer uses:

```
fsync temp file  →  rename temp to target  →  fsync target directory
```

It is implemented in
`v2/src/storage/internal/generation-store-io.ts`. DB promotion has a
separate ordering: fd copy+hash → temp fd verification/fsync → no-clobber
`link(temp, final)` → final identity verification → fsync `generations/`.
Any deviation breaks the
durability contract: `rename` before `fsync file` can leave the target
empty on crash; `fsync dir` before `rename` is useless; skipping
`fsync file` can lose file content on crash even if the rename
succeeds.

**Directory fsync failure is NOT silent.** If the directory cannot be
opened or if `fsync` on the directory fails, the writer raises
`ATOMIC_DURABILITY_UNKNOWN`. By the time this step runs, `rename` has
already happened, so the new target MAY be in place, but we cannot
guarantee durability without the directory fsync. The caller (indexer)
MUST re-read the target and diagnose. Silent success on directory-fsync
failure would let the indexer believe the new generation is durable
when in fact it may be rolled back by a power loss — exactly the kind
of partial-publication outcome R169 is meant to eliminate.

Two further properties of the atomic writer are part of the contract:

- **Serialization happens BEFORE any filesystem mutation.**
  `JSON.stringify` is wrapped in a try/catch (and the result type-
  checked). If it throws (BigInt, circular references) or returns a
  non-string (`undefined`, functions, symbols), the writer raises
  `ATOMIC_SERIALIZATION_FAILED` and **no temp file is created**.
- **Short writes are accounted for.** The write loop tracks an offset
  and continues from the new offset on partial writes. If `writeSync`
  returns `<= 0`, the writer raises `ATOMIC_SHORT_WRITE` and cleans up
  the temp file.

### 15.5.1–15.5.4 Security and durability authority

The generation-store trust-root walk, project-aware atomic writer, directory
durability behavior, manifest validation, symlink policy, and exact error
taxonomy are defined once in
[Atomic generation publication](ATOMIC_GENERATION_PUBLICATION.md#6-durability-ordering).

The architectural invariants are:

- validate the trusted root and every path component before access;
- reject symlinks and non-regular generation or legacy database targets;
- serialize before filesystem mutation and account for partial writes;
- fsync the file, promote without clobbering, and fsync the directory;
- fail closed on permission, I/O, path, identity, schema, or durability
  uncertainty;
- keep the public writer project-aware and the low-level filesystem helpers
  internal.

This summary intentionally does not reproduce the detailed state machine. The
linked document and storage source/tests are authoritative.

### 15.6 Reader contract

> **Resolve once. Open the resolved DB. Keep the handle.**

`resolveActiveCodeDb(project)` returns a discriminated union
(`generation | legacy | missing`). The reader opens `resolved.dbPath`
once and keeps the SQLite handle. Even if a concurrent publication
swaps the manifest, the reader's handle still points to the generation
it opened — and that generation is **immutable**.

### 15.7 Legacy migration

| Manifest state | Legacy DB state | Resolver result |
|---|---|---|
| valid | (ignored) | `generation` |
| absent | exists and is a regular file inside the trust root with no symlink chain | `legacy` |
| absent | exists but is a directory / symlink / special file / outside the trust root | **FAIL CLOSED** — `LEGACY_SOURCE_INVALID` (R169A-FIX-R2: renamed from `LEGACY_SOURCE_OPEN_FAILED`; the old name is retained only as a historical note) |
| absent | absent | `missing` |
| invalid (any reason) | (ignored) | **FAIL CLOSED** |
| manifest `dbFile` not canonical | (ignored) | **FAIL CLOSED** — `MANIFEST_DBFILE_NOT_CANONICAL` |
| manifest target not a regular file | (ignored) | **FAIL CLOSED** — `MANIFEST_TARGET_NOT_REGULAR` |
| any path component (manifest parent, `generations/`, target) is a symlink | (ignored) | **FAIL CLOSED** — `PATH_TRAVERSAL_REJECTED` |

An invalid manifest never silently falls back to legacy. The legacy DB
is only used when no manifest exists AND the legacy path passes the
same security invariants as the generation path:

1. **Project key containment.** The project name is checked lexically
   (no empty string, no absolute path, no `..`, no path separators, no
   `.`). The legacy path is constructed as `<cacheRoot>/<project>.db`
   and containment-checked against `<cacheRoot>` using
   `isLexicallyInside`.
2. **No symlink chain.** Every path component from `<cacheRoot>` down
   to the legacy DB file is walked with `lstat`; ANY symlink in the
   chain raises `PATH_TRAVERSAL_REJECTED`.
3. **Regular file.** `lstatSync(legacyPath)` must report a regular
   file. A directory, symlink, FIFO, socket, or device node raises
   `LEGACY_SOURCE_INVALID` (R169A-FIX-R2: renamed from
   `LEGACY_SOURCE_OPEN_FAILED`; R169A validates path + regular-file
   identity only — actual SQLite open validation occurs in R169D
   reader cutover). There is no "open it read-only anyway" fallback.

For ordinary project names with the real cache root, this produces the
same path as `defaultCodeDbPath` in `v2/src/bridge/sqlite-ro.ts`, so
back-compat is preserved on the happy path. Migration to generation-only
operation follows the validated R169A→R169E roadmap:

- **R169A** — Generation Store Contract + Resolver Foundation
  (merged / inactive).
- **R169B** — Durable Staging Publisher + Validator + fsync + CAS + GC
  and recovery primitives (merged / inactive; no production indexer caller).
- **R169C** — Future indexer integration + outcome contract.
- **R169D** — Future reader cutover + legacy migration + lifecycle.
- **R169E** — Future integrated crash matrix + performance + activation
  (and the formal close-out of `DATA-CARRY-01` after crash matrix +
  concurrency + performance + activation have all passed).

### 15.8 Failure taxonomy

Structured error codes, never a single `DB_ERROR` bucket. See
`GenerationStoreErrorCode` in `v2/src/storage/generation-types.ts`
(the source of truth — hardcoded counts in documentation go stale as
codes are added across R169B–R169E):

- `GENERATION_STORE_CONFIG_ERROR`
- `MANIFEST_PARSE_ERROR` / `MANIFEST_SCHEMA_ERROR`
- `MANIFEST_TOO_LARGE` (R169A-FIX-R2) — manifest file > 64 KiB; not read into memory
- `MANIFEST_TARGET_MISSING` / `MANIFEST_TARGET_OUTSIDE_STORE`
- `MANIFEST_TARGET_NOT_REGULAR` — dbFile resolves to a directory / symlink / special file
- `MANIFEST_DBFILE_NOT_CANONICAL` — dbFile is not `generations/generation-<generationId>.db`
- `MANIFEST_PROJECT_MISMATCH` / `MANIFEST_UNSUPPORTED_VERSION`
- `MANIFEST_SYMLINK_REJECTED` / `GENERATION_TARGET_SYMLINK_REJECTED`
- `LEGACY_SOURCE_INVALID` (R169A-FIX-R2: renamed from `LEGACY_SOURCE_OPEN_FAILED`) — legacy DB is a directory / symlink / special file / outside store; R169A validates path + regular-file identity only, actual SQLite open validation occurs in R169D reader cutover
- `ATOMIC_WRITE_FAILED` / `ATOMIC_RENAME_FAILED` / `ATOMIC_FSYNC_FAILED`
- `ATOMIC_DURABILITY_UNKNOWN` — directory open or fsync failed post-rename; target MAY be new, caller must re-read (NOT silent success)
- `ATOMIC_SERIALIZATION_FAILED` — `JSON.stringify` threw or returned non-string; no temp file created
- `ATOMIC_SHORT_WRITE` — `writeSync` returned `<= 0` mid-payload
- `STORE_LAYOUT_CREATE_FAILED` (R169A-FIX-R2) — `mkdir` of a layout directory failed
- `STORE_LAYOUT_DURABILITY_UNKNOWN` (R169A-FIX-R2) — directory or PARENT `fsync` failed during layout setup
- `PATH_TRAVERSAL_REJECTED` — path escapes store OR any component in the trust-root walk is a symlink / EACCES / EIO / ENOTDIR / ELOOP
- `PROJECT_KEY_INVALID`

Each code carries a `phase` (function name) and `project` for
diagnostics. The five codes added by the pass 1 audit fix
(`MANIFEST_TARGET_NOT_REGULAR`, `MANIFEST_DBFILE_NOT_CANONICAL`,
`ATOMIC_DURABILITY_UNKNOWN`, `ATOMIC_SERIALIZATION_FAILED`,
`ATOMIC_SHORT_WRITE`) close the four contracts documented in §15.5
and §15.7. The four codes added by the pass 2 audit fix
(`MANIFEST_TOO_LARGE`, `LEGACY_SOURCE_INVALID`,
`STORE_LAYOUT_CREATE_FAILED`, `STORE_LAYOUT_DURABILITY_UNKNOWN`)
close the four R2 contracts: manifest size bound + immutable key
authority (§15.5.2), trust root symlink bypass (§15.5.3), project-
aware writer (§15.5.4), and layout durability (§15.5.5).

### 15.9 GC policy

**Keep the active generation plus the two most recent previous
generations.** R169B implements CAS-backed plan/apply GC, explicit pinning,
identity/hash proof before deletion, Model-A locking across deletion, temp
sweeping, and interrupted-delete/orphan recovery. These primitives are
merged / inactive; the production indexer does not schedule them.

### 15.10 Recovery

The resolver fails closed: no silent fallback, `--force-legacy` flag, or
`CBM_IGNORE_GENERATION_STORE=1` escape hatch. R169B also implements
CAS/manifest reconciliation and orphan recovery primitives. Production
reader use and lifecycle recovery remain part of R169D.

### 15.11 Crash matrix (C01–C20)

Twenty activation crash points are enumerated in
[ATOMIC_GENERATION_PUBLICATION.md](ATOMIC_GENERATION_PUBLICATION.md)
§ 12. R169B already contains targeted fault-injection, child-process
crash, concurrency, and publisher/GC race evidence for the primitives.
The complete matrix against integrated indexer and readers remains the
future R169E activation gate.

### 15.12 Performance contract

**Zero hot-path overhead while unused.** No production code imports the
publisher/GC path at startup. No generation-store `fsync`, `mkdir`, or `lstat` runs
on the hot path. The legacy `defaultCodeDbPath` is unchanged and
remains the only path used by the indexer, readers, UI, MCP, and CLI.
Verified by the `R169A — No production behavior change` test block in
`v2/tests/storage/r169a-generation-store.test.ts`.

### 15.13 R170 boundary (lease / fencing)

The R169A/R169B primitive contract is single-host only. R170 will add
multi-host lease / fencing:
the indexer acquires a lease with a fencing token; the writer checks
the token and refuses to publish if it is stale. Fencing token is
required for publication authorization. The token may live in a
sidecar CAS/lease state, not necessarily in the manifest V1 content.
The exact location will be decided in R170 — candidates include
`index-state.json`, a separate `lease.json` sidecar, or a CAS entry
keyed by the project key. The V1 manifest schema is closed, so adding
a `leaseToken` field requires `formatVersion = 2` and a migration.
R170 may keep the token out of the manifest V1 content entirely and
store it in a sidecar CAS/lease state — the closed manifest schema is
compatible with either approach. `index-state.json` is the sidecar
where operational state (including lease) lives.

### 15.14 Activation plan

The validated R169A→R169E roadmap distinguishes merged foundations from
future product work. `DATA-CARRY-01` (P1) closes **only** at the
end of R169E, after the crash matrix (C01–C20), concurrency analysis,
performance verification, and activation gating have all passed.

| Round | Scope | Status |
|-------|-------|--------|
| R169A | Generation Store Contract + Resolver Foundation (paths, manifest V1, resolver, atomic JSON writer, validation/security contracts) | **merged / inactive** |
| R169B | Durable Publisher + Validator + fd copy/hash + temp fsync/link + metadata + manifest + CAS + GC/recovery primitives and test harnesses | **merged / inactive** (`15a732d91984e5b4ffa29b4e129ac0d6316c9fca`) |
| R169C | Indexer Integration + Outcome Contract | future |
| R169D | Reader Cutover + Legacy Migration + Project Lifecycle | future |
| R169E | Integrated Crash Matrix + Performance + Activation + Version (`DATA-CARRY-01` closure gate) | future |
| R170  | Multi-host lease / fencing | out of scope |

### 15.15 See also

- [ATOMIC_GENERATION_PUBLICATION.md](ATOMIC_GENERATION_PUBLICATION.md) —
  full target architecture (storage layout, manifest schema, state
  machine, durability ordering, reader contract, legacy migration,
  failure taxonomy, GC policy, recovery, crash matrix C01–C20,
  performance contract, R170 boundary).
- [V2_CURRENT_STATE.md](../reference/V2_CURRENT_STATE.md) — authoritative active legacy
  product versus merged/inactive generation-store boundary.
- `v2/src/storage/generation-store.ts` — resolver/foundation implementation.
- `v2/src/storage/generation-publisher.ts` — publisher implementation.
- `v2/src/storage/generation-gc.ts` — GC/recovery implementation.
- `v2/src/storage/generation-types.ts` — types and error codes.
- `v2/tests/storage/r169a-generation-store.test.ts` and
  `v2/tests/storage/r169b-*.test.ts` — foundation and primitive evidence.
