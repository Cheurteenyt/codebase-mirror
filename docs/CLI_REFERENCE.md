# CLI Reference — Codebase Memory V2

> Updated 2026-07-07 for version 0.15.3.

All commands are available via `cbm-v2` (or `node dist/cli/index.js` before global install).

## Core Commands

### `cbm-v2 init`
Initialize `.codebase-memory.json` configuration file.

```bash
cbm-v2 init --project my-app
cbm-v2 init --project my-app --vault /custom/vault/path
```

### `cbm-v2 doctor`
Run diagnostics to verify the setup.

```bash
cbm-v2 doctor --project my-app
```

Checks: Node.js version (≥18), config file, human DB, code graph DB, vault path writability.

### `cbm-v2 stats`
Show a pretty statistics dashboard.

```bash
cbm-v2 stats --project my-app
cbm-v2 stats --project my-app --json
```

### `cbm-v2 demo`
Create a demo project with sample notes and generate a vault. No V1 codebase needed.

```bash
cbm-v2 demo                    # creates temp files, cleans up after
cbm-v2 demo --keep             # keeps the files
cbm-v2 demo --vault ./my-vault # uses a specific vault path
```

### `cbm-v2 mcp`
Run as MCP server (JSON-RPC 2.0 over stdio). For AI agent integration.

```bash
cbm-v2 mcp --project my-app
```

### `cbm-v2 ui`
Start the graph UI web server (2D d3-force canvas, dashboard, filters).

```bash
cbm-v2 ui --project my-app                     # http://127.0.0.1:9749
cbm-v2 ui --project my-app --port 8080         # custom port
cbm-v2 ui --project my-app --graph-ui-path /custom/dist  # custom UI build
```

The UI has 4 tabs:
- **Dashboard** (default when a project is selected): KPIs, graph freshness, recommendations
- **Graph**: 2D force-directed canvas with filters, sidebar, node detail panel
- **Projects**: Project list with node/edge counts and health status
- **Control**: System info

### `cbm-v2 watch`
Watch the Obsidian vault for file changes and auto-sync (daemon mode).

```bash
cbm-v2 watch --project my-app                              # default: direction=both
cbm-v2 watch --project my-app --direction import           # vault -> DB only
cbm-v2 watch --project my-app --direction export           # DB -> vault only
cbm-v2 watch --project my-app --debounce 1000             # 1s debounce (default: 500ms)
cbm-v2 watch --project my-app --no-backup --no-auto-modules
```

The watch daemon uses Node.js `fs.watch` (recursive, Node 18+) to monitor the vault directory. When a `.md` file is created, modified, or deleted:

1. **Debounce**: waits 500ms (configurable) for the file system to settle
2. **Import**: runs `importVault` to pull vault changes into the DB
3. **Export**: runs `generateVault` to regenerate AUTO-GENERATED sections
4. **Notify**: pushes WebSocket notifications to connected UI clients

The daemon also subscribes to the `NotifyHub` so that DB-side mutations (from
MCP tools or API endpoints running in the same process) trigger an automatic
export. To prevent the import path from redundantly triggering an export of
its own output, `runSync()` tags its explicit `hub.notify()` calls with
`{ source: 'watch-import' }`, and the hub subscriber skips events carrying
that tag — since `runSync()` already ran `generateVault()` inline. Internal
store-level events (`createNode`/`updateNode` fired inside `importVault`)
are not tagged and still schedule a second `generateVault()` call after the
debounce window; this is a known no-op (the generator's frontmatter diff
detection skips unchanged files), so the redundancy is harmless by design.

Press `Ctrl+C` to stop the daemon.

## Human Memory Commands

### `cbm-v2 human create`
Create a human memory note.

```bash
cbm-v2 human create \
  --project my-app \
  --type ADR \
  --title "ADR-001: Use JWT" \
  --body "We chose JWT because..." \
  --tag security --tag auth \
  --link-cbm 1234 --link-edge DECIDES \
  --status active
```

**Validation** (R15): `--link-edge` is always validated, even if no `--link-cbm` is provided. Previously an invalid edge type was silently accepted when no links were created.

### `cbm-v2 human list`
List notes with optional filters.

```bash
cbm-v2 human list --project my-app
cbm-v2 human list --project my-app --type ADR --status active --limit 50
```

### `cbm-v2 human show`
Show a single note (JSON output, includes edges).

```bash
cbm-v2 human show 42 --project my-app
```

**R15**: The output now includes the note's edges (up to 1000), so you can see what code nodes and human nodes it's linked to.

### `cbm-v2 human link`
Link a note to a code node.

```bash
cbm-v2 human link 42 --project my-app --to-cbm-node 1234 --edge DECIDES
```

**R22**: Now validates that the `cbm_node_id` exists in the code graph (if a code reader is available), like the `create_human_note` MCP tool. Previously, linking to a non-existent code node silently succeeded.

## Obsidian Commands

### `cbm-v2 obsidian init`
Create vault directory structure.

```bash
cbm-v2 obsidian init --project my-app --vault .codebase-memory-vault
```

### `cbm-v2 obsidian sync`
Bidirectional sync (DB ↔ vault). The main sync command.

```bash
cbm-v2 obsidian sync --project my-app
cbm-v2 obsidian sync --project my-app --dry-run
cbm-v2 obsidian sync --project my-app --direction export
cbm-v2 obsidian sync --project my-app --direction import
cbm-v2 obsidian sync --project my-app --no-backup --no-auto-modules
cbm-v2 obsidian sync --project my-app --min-degree 30
```

### `cbm-v2 obsidian export` / `import`
One-shot export (DB → vault) or import (vault → DB).

```bash
cbm-v2 obsidian export --project my-app
cbm-v2 obsidian import --project my-app --dry-run
```

### `cbm-v2 obsidian report`
Print a vault file report.

```bash
cbm-v2 obsidian report --project my-app --format json
```

### `cbm-v2 obsidian create-adr`
Create an ADR note + DB record.

```bash
cbm-v2 obsidian create-adr --project my-app --title "ADR-003: Use Redis" --module auth --status draft
```

### `cbm-v2 obsidian create-module-note`
Create a ModuleNote for a specific module.

```bash
cbm-v2 obsidian create-module-note --project my-app --module auth
```

**R15**: Errors with a clear message if a ModuleNote already exists for this module (previously `createNode` would auto-suffix the slug, producing an unexpected `obsidian_path`).

### `cbm-v2 obsidian create-route-note`
Create a RouteNote for a specific HTTP route.

```bash
cbm-v2 obsidian create-route-note --project my-app --method POST --path /api/login
```

**R15**: Same pre-creation check as `create-module-note`.

## Report Commands

### `cbm-v2 report hotspots`
List critical modules (high degree + complexity).

```bash
cbm-v2 report hotspots --project my-app --min-degree 30 --limit 100 --format json
```

### `cbm-v2 report undocumented`
List critical code nodes without human notes.

```bash
cbm-v2 report undocumented --project my-app
```

### `cbm-v2 report risk`
Risk report: high coupling, dead code, fragile interfaces, central functions.

```bash
cbm-v2 report risk --project my-app --limit 200 --format json
```

## Backup Commands

### `cbm-v2 backup export`
Export all human notes + edges to a portable JSON file.

```bash
cbm-v2 backup export --project my-app --output backup.json
```

**R15**: Now exports ALL fields (`provenance`, `confidence`, `source_file`, `last_synced_at` for notes; `provenance`, `confidence`, `source_file` for edges). Previously these fields were lost on export. Also uses a single `listAllEdges` query instead of N+1 per-note queries.

### `cbm-v2 backup import`
Import from a JSON backup file.

```bash
cbm-v2 backup import backup.json --project my-app
cbm-v2 backup import backup.json --project restored-app --dry-run
```

**R15**: Skipped notes now log WHY they were skipped (slug collision or obsidian_path collision). Previously skips were silent.

## Global Options

| Option | Description |
|---|---|
| `-V, --version` | Output version number |
| `-h, --help` | Display help for command |

## Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error (validation, DB, filesystem) |

