# V2 Architecture — Codebase Memory V2

> **Status:** FOUNDATION / INACTIVE (R169A) — implemented candidate, pending review
> **Last verified:** 0.75.0 / R169A — generation store foundation is an implemented candidate, inactive, pending review.
> Current behavior (indexer, readers, UI, MCP, CLI) is unchanged from R168.1 and still uses the legacy `<project>.db` path. The R169A foundation is an implemented candidate — no production code path calls it. `DATA-CARRY-01` (P1) remains OPEN until R169E (after crash matrix + concurrency + performance + activation).

## 1. System Context

Codebase Memory V2 is a hybrid code intelligence system that combines:

- A **native WASM indexer** (112 languages via tree-sitter) that builds a
  code graph in SQLite without requiring a C engine.
- A **human memory graph** (SQLite) for notes, ADRs, and Obsidian sync.
- An **MCP server** exposing 7 tools for code graph queries and human
  memory CRUD.
- A **web-based graph UI** (React/Vite) served by the V2 backend.

The V1 C engine is retained as a **reference and fallback** for languages
not yet covered by the WASM indexer, but V2 is fully autonomous for
TypeScript/JavaScript projects.

## 2. Monorepo Components

```
v2/             Core: CLI, indexer, MCP, human memory, UI server
graph-ui/       Frontend: React/Vite graph visualization
v1-reference/   Historical C engine (reference + fallback)
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

## 4. V1 C Engine — Fallback/Reference

The V1 C engine (`v1-reference/`) is retained for:
- Languages not yet supported by the WASM indexer
- Performance comparison benchmarks
- Historical reference

V2 detects V1 (presence of `<project>.db`) and can use it as a read-only
code graph source via the bridge module. V2 can also write the code graph
independently of V1.

## 5. SQLite Code Graph

The code graph is stored in a SQLite database (`<project>.db`) with:

- `nodes` — exported symbols (functions, classes, types)
- `edges` — call relationships (caller → callee)
- `file_hashes` — file content hashes for incremental indexing
- `projects` — project metadata (root path, fingerprint, stale flag)
- `alias_history` — historical alias targets for protection

Schema version: `CURRENT_EXTRACTOR_SEMANTICS_VERSION = 8`
Discovery policy version: `CURRENT_DISCOVERY_POLICY_VERSION = 2`

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

## 8. MCP Server

The MCP (Model Context Protocol) server exposes 7 tools:

1. `search_code` — search the code graph
2. `get_node` — get a specific code node
3. `get_edges` — get call relationships
4. `list_projects` — list indexed projects
5. `add_note` — add a human memory note
6. `list_notes` — list human memory notes
7. `sync_obsidian` — sync with Obsidian vault

## 9. Graph UI

A React/Vite application (`graph-ui/`) served by the V2 backend:

- **Force-directed graph** visualization (d3-force)
- **Real-time updates** via WebSocket
- **Project switcher** with health indicators
- **Human memory** tab (notes, ADRs)
- **Index status** with stale/recovery info

The UI is built and embedded in the npm package at `dist/ui/`. Runtime
resolution uses `import.meta.url` so it works from any working directory.

## 10. Publication (current state + R169 target)

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

### R169 target (Atomic Generation Publication)

```
reader sees:
  old complete snapshot
  OR
  new complete snapshot
  never a partial publication
```

Architecture: generation DB + manifest + atomic rename + fsync + GC.

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
- Dependabot: github-actions ecosystem, weekly PRs
- Branch protection: `main` protected, fast-forward only for mirror

## 14. Limitations

- No atomic generation publication (R169 target)
- No project lease/fencing (R170 target)
- Node 20 only in CI (Node 22/24 matrix deferred)
- No GitHub Release yet (pre-release after R169 + R170)
- Repository name `codebase-mirror` is misleading (rename deferred)
## 15. R169A — Generation Store Target Architecture (FOUNDATION / INACTIVE)

> **Status: FOUNDATION / INACTIVE — implemented candidate, pending review.**
> The target architecture documented in this section is **not active**.
> The foundation code is an implemented candidate, tested, but no
> production code path calls it. The indexer still writes to the legacy
> `<project>.db` path; readers still open the legacy DB directly. This
> section describes the target, not the current behavior. `DATA-CARRY-01`
> (P1) remains OPEN until R169E (after crash matrix + concurrency +
> performance + activation).

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

### 15.4 State machine

```
START → BUILD_STAGING → VALIDATE → FINALIZE → CAS → MANIFEST → FINAL_STATE
```

- **BUILD_STAGING:** write `generations/generation-<uuid>.db` into
  `tmp/` (not yet visible to readers).
- **VALIDATE:** open the staging DB, run consistency checks (row counts,
  sha256, schema version, root fingerprint).
- **FINALIZE:** `fsync` the staging DB file.
- **CAS:** `rename` the staging DB from `tmp/` to `generations/`
  (atomic on POSIX).
- **MANIFEST:** write `active-generation.json` atomically.
- **FINAL_STATE:** the new generation is live; the old generation is
  now stale and will be collected by GC.

The DB is **fully written and fsynced** before the manifest is touched.
The manifest swap is the **only** visible mutation to readers.

### 15.5 Durability ordering

```
fsync file  →  rename  →  fsync dir
```

Implemented in `writeJsonAtomically(targetPath, value)` in
`v2/src/storage/generation-store.ts`. Any deviation breaks the
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
R169A-FIX-R2 introduces `writeProjectJsonAtomically`, the ONLY public
writer API. The internal `writeJsonAtomically` is not exported.

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
| absent | exists but is a directory / symlink / special file / outside the trust root | **FAIL CLOSED** — `LEGACY_SOURCE_OPEN_FAILED` |
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
back-compat is preserved on the happy path. Migration to generation-
only operation happens across the validated R169A→R169E roadmap:

- **R169A** — Generation Store Contract + Resolver Foundation
  (this round; implemented candidate, inactive, pending review).
- **R169B** — Durable Staging Publisher + Validator + fsync + CAS + GC
  primitives. Implement independent publisher primitives and test
  harnesses — NO production indexer caller.
- **R169C** — Indexer Integration + Outcome Contract. Wire those
  primitives into `indexProjectWasm` and outcome paths.
- **R169D** — Reader Cutover + Legacy Migration + Project Lifecycle.
- **R169E** — Crash Matrix + Performance + Activation + Version
  (and the formal close-out of `DATA-CARRY-01` after crash matrix +
  concurrency + performance + activation have all passed).

### 15.8 Failure taxonomy

Structured error codes, never a single `DB_ERROR` bucket. See
`GenerationStoreErrorCode` in `v2/src/storage/generation-types.ts`
(24 codes — 15 original + 5 from GPT 5.6 pass 1 + 4 from pass 2):

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
generations.** Older generations are deleted. `tmp/` is swept on every
GC pass for orphan files older than a threshold (default 1 hour). GC is
best-effort and never deletes the active generation. GC is **not**
enabled in R169A.

### 15.10 Recovery

Fail closed and stay closed. No silent fallback, no `--force-legacy`
flag, no `CBM_IGNORE_GENERATION_STORE=1` escape hatch. A manifest that
fails validation must be repaired or deleted before reads succeed for
that project.

### 15.11 Crash matrix (C01–C20)

Twenty crash points are enumerated in
[ATOMIC_GENERATION_PUBLICATION.md](ATOMIC_GENERATION_PUBLICATION.md)
§ 12. The common property: a crash never leaves the reader seeing a
partial publication. The reader sees either the previous complete
snapshot or the new complete snapshot, depending on whether the
manifest rename (C12) survived.

### 15.12 Performance contract

**Zero overhead when unused.** No production code imports
`generation-store.js` at startup. No `fsync`, `mkdir`, or `lstat` runs
on the hot path. The legacy `defaultCodeDbPath` is unchanged and
remains the only path used by the indexer, readers, UI, MCP, and CLI.
Verified by the `R169A — No production behavior change` test block in
`v2/tests/storage/r169a-generation-store.test.ts`.

### 15.13 R170 boundary (lease / fencing)

R169A is single-host only. R170 will add multi-host lease / fencing:
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

The validated R169A→R169E roadmap. Each round activates one piece with
its own tests and audit. `DATA-CARRY-01` (P1) closes **only** at the
end of R169E, after the crash matrix (C01–C20), concurrency analysis,
performance verification, and activation gating have all passed.

| Round | Scope | Status |
|-------|-------|--------|
| R169A | Generation Store Contract + Resolver Foundation (path helpers, manifest V1 types, resolver, atomic JSON writer, plus the eight contracts from R169A-FIX pass 1 + pass 2: canonical `dbFile`, symlink chain security, directory fsync → `ATOMIC_DURABILITY_UNKNOWN`, legacy validation, trust root symlink bypass, project-aware writer, layout durability, manifest size bound + immutable key authority) | **implemented candidate — INACTIVE, pending review** |
| R169B | Durable Staging Publisher + Validator + fsync + CAS + GC primitives (independent primitives + test harnesses — NO production indexer caller) | planned |
| R169C | Indexer Integration + Outcome Contract (wire primitives into `indexProjectWasm` and outcome paths) | planned |
| R169D | Reader Cutover + Legacy Migration + Project Lifecycle | planned |
| R169E | Crash Matrix + Performance + Activation + Version (and `DATA-CARRY-01` close — only after crash matrix + concurrency + performance + activation) | planned |
| R170  | Multi-host lease / fencing | out of scope |

### 15.15 See also

- [ATOMIC_GENERATION_PUBLICATION.md](ATOMIC_GENERATION_PUBLICATION.md) —
  full target architecture (storage layout, manifest schema, state
  machine, durability ordering, reader contract, legacy migration,
  failure taxonomy, GC policy, recovery, crash matrix C01–C20,
  performance contract, R170 boundary).
- [V2_CURRENT_STATE.md](V2_CURRENT_STATE.md) — R169A section
  (foundation implemented as a candidate, inactive, pending review,
  publication NOT active).
- `v2/src/storage/generation-store.ts` — implementation.
- `v2/src/storage/generation-types.ts` — types and error codes.
- `v2/tests/storage/r169a-generation-store.test.ts` — test matrix.
