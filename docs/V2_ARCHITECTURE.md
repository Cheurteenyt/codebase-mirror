# V2 Architecture — Codebase Memory V2

> **Last verified:** 2026-07-15 at 0.76.0. R169A and R169B are merged;
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
- An **MCP server** exposing 7 tools for code graph queries and human
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

The MCP (Model Context Protocol) server exposes these 7 tools:

1. `get_project_overview` — summarize graph, human-memory, coverage, and freshness state
2. `get_module_context` — return code and human context for one module or file
3. `get_undocumented_hotspots` — rank critical code nodes without documentation
4. `create_human_note` — create a human-memory note and optionally link code nodes
5. `link_note_to_code_node` — link an existing note to an existing code node
6. `search_code_and_memory` — search the code graph and human memory together
7. `prepare_edit_context` — assemble dependency, risk, freshness, and note context before editing

Obsidian synchronization is a separate CLI/watch responsibility; none of the
seven MCP tools is a vault-sync command.
The stdio server negotiates MCP `2025-11-25`, `2025-06-18`, or legacy
`2024-11-05`, rejects JSON-RPC batches, and keeps `tools/call` closed until a
standalone initialize request is followed by `notifications/initialized`.
Bounded coverage responses label partial scans and lower-bound counts instead
of presenting the sampled portion as exact project-wide state.

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
simulation. Without a focus,
exact full-graph degree pulls hubs toward the center while directory
communities retain angular sectors. Selecting a visible symbol pins it to the
semantic origin, unfolds up to four visible incoming relation layers to the left and
outgoing layers to the right, and retains unrelated symbols as dim outer
context. Numbered rails come only from real directed paths. Repeated directory
lanes receive a bounded module label; direct and transit edges share one
five-group color/dash grammar, and the DOM guide lists only relation groups
incident to the selected node. Incoming labels prefer left-facing anchors,
outgoing labels prefer right-facing anchors, and each has two deterministic
vertical fallbacks before omission. Exact degree still selects the V1 reference spectral scale, node type
selects a circle/diamond/square glyph, and only the selected flow receives
direction markers. Status remains an outer stroke. Invalid or unavailable local
storage falls back to `Structure`.

In the unfocused frame, top-level project paths form contiguous elliptical
sectors and small path families collapse into one quiet `other` sector. Colored
boundary arcs and exact representative counts expose project structure without
duplicating the Structure domain renderer. The hub halo and stronger
backbone remain batched; a separate 12-label overview budget uses radial
collision candidates and excludes low-information names. Sector summaries,
hub membership, and label candidates are all precomputed on semantic-frame
changes, so the additional hierarchy does not add a graph scan per paint.
The six largest represented communities containing at least four shown nodes
may also receive a subdued path/count caption. Each is anchored to the
highest-ranked informative symbol already present in the precomputed overview
plan and participates in the shared collision pass. Decorative inner rings are
not rendered; the sector boundary remains the only persistent orbit.

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
screen rectangle.

This boundary is deliberate: changing task view reuses every d3 node object,
event listener, exactness contract, and canvas allocation. A view/focus change
receives one bounded simulation reheat; known filter subsets and restorations
remain settled. Sampling, exact values, filtering, navigation, accessibility,
and detail logic are not forked. The active focus alone is fixed at `(0,0)` and
is released when selection or mode changes, preventing high-fan-out link forces
from moving the semantic origin. Hub bloom, orbit guides, depth rails, and the
focused flow axis are batched Canvas paths; there are no shadows, per-node gradients,
Three.js scene, WebGL backend, or second layout engine. The Graph application
chunk remains protected by its 40 KiB gzip budget; the stable `d3-*` force stack
is cached separately and both remain covered by the global JavaScript budget.

The bounded overview is followed by a revision-bound exact drill-down rather
than a second renderer. `GET /api/scope` keyset-pages a domain or directory
community. A node batch owns every internal edge whose highest-id endpoint it
introduces; edge-only continuation pages drain dense batches before the node
frontier advances. This makes page merging duplicate-free and prevents a page
from referencing a node the client has not loaded. The UI renders the merged
frame in the existing `GraphCanvas`/d3 simulation with raw topology enabled,
labels partial versus complete truth, re-fits only at the overview/detail frame
boundary, and restarts from page one on `GRAPH_REVISION_MISMATCH`. The read-only
bridge derives all domain/community memberships in one node pass per graph
revision, then reuses that bounded cache across scopes and continuation pages;
edge membership stays in SQLite through a materialized `json_each` CTE.

The UI is built and embedded in the npm package at `dist/ui/`. Runtime
resolution uses `import.meta.url` so it works from any working directory.
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

See [GITHUB_GITLAB_BRANCH_BRIDGE.md](GITHUB_GITLAB_BRANCH_BRIDGE.md) for
the full architecture, postmortem, and diagnostic matrix.

## 12. Packaging

- **npm package**: `v2/package.json` with `files: ["dist", "README.md", "CHANGELOG.md", "LICENSE"]`
- **Build**: `npm run build:package` (via `scripts/build-package.mjs`)
  builds graph-ui + v2 backend + copies UI assets to `dist/ui/`
- **Docker**: 3-stage build (ui-builder → builder → runtime)
- **Lockfiles**: `v2/package-lock.json` + `graph-ui/package-lock.json`
  committed for reproducibility

See [RELEASE_POLICY.md](RELEASE_POLICY.md) for release governance.

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
- Repository name `codebase-mirror` is misleading (rename deferred)
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

### 15.5.1 Symlink chain security

The resolver walks every path component from a higher-trust root
(`generationStoreRoot`) down to both the manifest path and the
generation DB path. For each component it performs an `lstat` and
rejects ANY symlink in the chain — not just the final hop. The final
candidate is verified with `realpathSync.native` and containment-
checked against the trust root.

Error policy on the walk:

- `ENOENT` on a component → return silently (the path is absent; the
  resolver falls back to legacy or returns `missing`).
- `EACCES`, `EIO`, `ENOTDIR`, `ELOOP` → fail closed with
  `PATH_TRAVERSAL_REJECTED`. These are not swallowed: a permission or
  I/O error during the walk is treated as evidence of tampering or
  filesystem corruption, not as "absent".

A manifest parent directory that is a symlink, a `generations/`
directory that is a symlink, or a generation DB that is a symlink are
ALL rejected. The legacy DB path uses the same walk and the same
`lstat` chain.

### 15.5.2 Trust root validation (R169A-FIX-R2 SEC-R169A-R2-01)

`assertPathInsideNoSymlinks(root, candidate)` only walks components UNDER
`root`. It never `lstat`'s `root` itself. If `projects/` (or any of its
parents) is a symlink to an attacker-controlled directory, both
`realpath(root)` and `realpath(candidate)` follow the same symlink, and
the containment check passes — bypassing the trust boundary.

R169A-FIX-R2 closes this bypass with `assertTrustedRootNoSymlinks`,
called by the resolver AND the writer BEFORE checking the manifest /
legacy path / target. The function `lstat`'s `cacheRoot` itself and
walks `codebase-memory-mcp`, `projects`, `<project-key>` — ANY symlink in
this chain raises `PATH_TRAVERSAL_REJECTED`. Only `ENOENT` is tolerated
(component doesn't exist yet — common during the first write for a
project); `EACCES` / `EIO` / `ENOTDIR` / `ELOOP` fail closed.

### 15.5.3 Project-aware atomic writer (R169A-FIX-R2 SEC-R169A-R2-02)

`writeJsonAtomically(targetPath, value)` accepted an arbitrary
`targetPath` with no containment check, no symlink rejection, and did
`mkdir -p` which could create directories via parent symlinks.
R169A-FIX-R2 introduced `writeProjectJsonAtomicallyInternal` (the
project-aware wrapper). **It is INTERNAL** — it lives in
`v2/src/storage/internal/generation-store-io.ts`, is NOT exported
from the public facade, and receives a canonical-payload `Buffer`
(not a JSON-serializable value). The ONLY public writer in R169A is
`writeIndexStateAtomically(project, state, options?)`. The
low-level `writeJsonAtomically(targetPath, payload: Buffer, ...)` is
also internal and not exported. R169B owns the first public publication
API, `publishPreparedGeneration`.

The wrapper:

1. Derives the target path from `project` + `target` type (`"manifest"`
   → `activeManifestPath`; `"index-state"` → `indexStatePath`). The
   caller CANNOT specify an arbitrary path.
2. Validates the trust root (§15.5.2).
3. Validates the target path via `assertPathInsideNoSymlinks`.
4. Rejects symlinked targets via `assertNotSymlink`.
5. Ensures layout durability (§15.5.4).
6. Delegates to the internal `writeJsonAtomically` for the temp-rename-
   fsync pattern. Temp file mode `0600`, temp directory mode `0700`.

### 15.5.4 Layout durability (R169A-FIX-R2 DUR-R169A-R2-01)

`mkdir -p` + `fsync(dir)` does NOT guarantee the directory ENTRY in the
parent survives a crash if the directory was just created.
`ensureGenerationStoreLayoutDurable` walks the FULL layout chain
(`cbm` → `projects` → `projectStore` → `generations`, `tmp`); for each
directory:

1. `lstat` — if it doesn't exist, `mkdir` with mode `0700`. Failure →
   `STORE_LAYOUT_CREATE_FAILED`.
2. `fsync` the directory itself. Failure →
   `STORE_LAYOUT_DURABILITY_UNKNOWN`.
3. If newly created, `fsync` the PARENT directory so the directory
   ENTRY in the parent is durable. Failure →
   `STORE_LAYOUT_DURABILITY_UNKNOWN`.

The chain does NOT include `cacheRoot` itself — that is the user's HOME
cache dir, created by the OS / XDG machinery.

### 15.5.5 Manifest hardening (R169A-FIX-R2 VALID-R169A-R2-01)

Four hardenings:

- **Size bound.** `MAX_GENERATION_MANIFEST_BYTES = 64 * 1024`. Before
  reading, `parseGenerationManifest` stats the file; if `size > max`,
  raises `MANIFEST_TOO_LARGE` and does NOT read the file into memory.
  Reads use `openSync` + `readSync` + `closeSync` so the exact byte
  count is controlled.
- **`rootFingerprint` validation.** `trim().length > 0` (reject
  whitespace-only), max 1024 chars, no C0 control characters
  (charCode 0–31, including NUL and tab).
- **`project` field validation.** Same safe-string rules as
  `rootFingerprint`, applied BEFORE the equality check against
  `expectedProject`. Defense-in-depth against a corrupted manifest
  that happens to match `expectedProject` but contains control chars.
- **Immutable key authority.** `MANIFEST_V1_KEYS` is now exported as a
  readonly tuple (`as const`), NOT a mutable `Set`. The validator uses
  a private `MANIFEST_V1_KEY_SET` (module-scoped, not exported). A
  consumer cannot `.add()` / `.delete()` from the authority; even if
  the tuple is mutated at runtime, the private set is unaffected. The
  public helper `isManifestV1Key(key)` is the only supported query API.

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
- [V2_CURRENT_STATE.md](V2_CURRENT_STATE.md) — authoritative active legacy
  product versus merged/inactive generation-store boundary.
- `v2/src/storage/generation-store.ts` — resolver/foundation implementation.
- `v2/src/storage/generation-publisher.ts` — publisher implementation.
- `v2/src/storage/generation-gc.ts` — GC/recovery implementation.
- `v2/src/storage/generation-types.ts` — types and error codes.
- `v2/tests/storage/r169a-generation-store.test.ts` and
  `v2/tests/storage/r169b-*.test.ts` — foundation and primitive evidence.
