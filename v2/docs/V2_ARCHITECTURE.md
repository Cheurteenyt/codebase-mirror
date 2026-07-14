# V2 Architecture — Codebase Memory

**Version:** 0.75.0  
**Last updated:** 2026-07-14 (R169B-STEP10)

## 1. Overview

Codebase Memory V2 is a TypeScript codebase indexer that builds a
content-addressed graph of nodes (functions, classes, modules) and
edges (calls, imports, exports) from a source tree. The graph is
stored in a SQLite database per "generation", and generations are
published atomically via the R169A/R169B durable publication pipeline.

The system has five layers:

1. **Storage** — the generation store (R169A foundation + R169B durable
   publisher). Manages staging, publication, CAS catalog, and GC.
2. **Indexer** — the extractor pipeline. Walks the source tree, runs
   the WASM extractor, resolves cross-file references, and writes to
   a staging DB.
3. **Intelligence** — graph status, SWR cache, TTL cache. Provides
   cached views of the graph for the UI.
4. **UI** — HTTP server with routes for graph, project, system, and
   human notes.
5. **MCP** — Model Context Protocol server with tools for AI agents
   to query the codebase.

## 2. Module Dependency Graph

```
                    ┌─────────────┐
                    │   cli/      │
                    │   index.ts  │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼─────┐ ┌───▼────┐ ┌────▼─────┐
       │  indexer/  │ │  ui/   │ │   mcp/   │
       │  indexer   │ │ server │ │  server  │
       └──────┬─────┘ └───┬────┘ └────┬─────┘
              │            │            │
              │     ┌──────▼─────┐      │
              │     │intelligence│      │
              │     │  swr-cache │      │
              │     └──────┬─────┘      │
              │            │            │
       ┌──────▼────────────▼────────────▼──────┐
       │            storage/                    │
       │  generation-store (facade)             │
       │  generation-publisher                   │
       │  generation-gc                          │
       │  generation-validation                  │
       │  generation-paths                       │
       │  generation-types                       │
       │  internal/                              │
       │    generation-cas-store                 │
       │    generation-store-io                  │
       │    generation-publisher-ops             │
       │    generation-layout-io                 │
       └────────────────────────────────────────┘
```

Dependency direction: top-down. The storage layer is the foundation;
the indexer depends on storage; the UI and MCP depend on both.

## 3. Storage Layer

The storage layer implements the Atomic Generation Publication system
(see `docs/ATOMIC_GENERATION_PUBLICATION.md` for the full design).

### 3.1 Generation lifecycle

```
reserve → populate → prepare → publish
                                      │
                                      ▼
                              [active generation]
                                      │
                                      │ (GC)
                                      ▼
                              [archived → deleted]
```

A generation is a complete snapshot of the indexer's output:
- `<projectStore>/generations/generation-<uuid>.db` — the SQLite DB.
- `<projectStore>/generations/generation-<uuid>.json` — the metadata sidecar.
- `<projectStore>/active-manifest.json` — points at the current active generation.
- `<projectStore>/publication-cas.sqlite` — the CAS catalog.

### 3.2 CAS catalog

The CAS (compare-and-swap) store serializes concurrent publishers via
`BEGIN IMMEDIATE`. Each publication increments the `revision` counter.
The GC uses the revision to detect stale plans (if the revision
changed between plan and apply, the plan is stale and no deletions
happen).

### 3.3 GC Model A

The GC holds the CAS lock during the entire deletion (BEGIN IMMEDIATE
→ mark DELETING → delete files → fsync → confirm → mark DELETED →
COMMIT). This prevents the race where a generation becomes active
between the safety check and the deletion.

### 3.4 Crash safety

The publisher uses a temp-file promotion protocol (create temp in
generations/ → fd-based copy+hash → fsync → link(temp, final) →
cleanup temp). If any step fails, the publication is blocked and the
token reverts to PREPARED (if no visible mutation). The crash harness
(C3) validates this via fault injection and child-process SIGKILL
tests.

## 4. Indexer Pipeline

The indexer walks the source tree, runs the WASM extractor on each
file, resolves cross-file references, and writes to a staging DB.

```
fast-walker → extractor (WASM) → cross-file-resolver → schema → staging DB
```

- `fast-walker` — walks the source tree, skips node_modules, .git, etc.
- `extractor` — runs the WASM extractor (tree-sitter based) on each file.
- `cross-file-resolver` — resolves imports, exports, calls across files.
- `schema` — initializes the SQLite schema (nodes, edges, file_hashes,
  call_sites, imports, exports, alias_history, projects).

The indexer supports incremental re-indexing (only re-extracts changed
files) and full re-indexing (re-extracts everything).

## 5. Intelligence Layer

- `graph-status` — tracks the completeness/freshness of the graph.
- `swr-cache` — stale-while-revalidate cache for graph queries.
- `ttl-cache` — time-to-live cache for short-lived data.

## 6. UI Server

The UI server is an HTTP server with routes:
- `/` — landing page.
- `/graph` — graph visualization.
- `/project` — project management.
- `/system` — system status.
- `/human` — human notes.

The server uses Server-Sent Events (SSE) for real-time updates via
`notify-hub.ts`.

## 7. MCP Server

The MCP (Model Context Protocol) server exposes tools for AI agents:
- `get_module_context` — get the context of a specific module.
- `get_project_overview` — get an overview of the project.
- `get_undocumented_hotspots` — find undocumented code.
- `search_code_and_memory` — search the codebase + human notes.
- `create_human_note` — create a human note.
- `link_note_to_code_node` — link a note to a code node.
- `prepare_edit_context` — prepare context for an edit.

## 8. Bridge Layer

- `sqlite-ro` — read-only SQLite bridge for the UI to query the
  generation DB without going through the indexer.

## 9. Obsidian Integration

- `vault` — Obsidian vault synchronization.
- `generator` — generates Obsidian markdown from the codebase.
- `importer` — imports Obsidian notes into the human store.
- `frontmatter` — parses/writes Obsidian frontmatter.
- `wikilinks` — resolves Obsidian wikilinks.

## 10. Configuration

- `config.ts` — reads configuration from environment variables and
  `.cbmrc` files.
- `constants.ts` — constants (version, default paths, etc.).

## 11. Build & Test

- TypeScript: `npx tsc --noEmit -p tsconfig.json`
- Build: `npm run build`
- Tests: `npx vitest run`
- Benchmarks: `npx tsx scripts/publication-benchmark-r169b.ts`

The test suite has 1775+ tests covering the storage layer, indexer,
UI, MCP, and integration scenarios. The R169B-specific tests (228)
validate the durable publication pipeline end-to-end.
