# Codebase Memory V2 — Sidecar TypeScript

> Couche V2 ajoutée à [Codebase Memory MCP](https://github.com/DeusData/codebase-memory-mcp).
> Apporte la **mémoire humaine** (ADR, BugNote, RefactorPlan, Convention, etc.)
> et la **synchronisation Obsidian** par-dessus le moteur C existant.

## Documentation

- [`docs/V2_AUDIT.md`](../docs/V2_AUDIT.md) — Audit technique du moteur C V1
- [`docs/V2_ARCHITECTURE.md`](../docs/V2_ARCHITECTURE.md) — Architecture V2 (sidecar TS)
- [`docs/V2_ROADMAP.md`](../docs/V2_ROADMAP.md) — Roadmap MVP → V1 → V2
- [`docs/OBSIDIAN_INTEGRATION.md`](../docs/OBSIDIAN_INTEGRATION.md) — Intégration Obsidian
- [`docs/HUMAN_MEMORY_GRAPH_SCHEMA.md`](../docs/HUMAN_MEMORY_GRAPH_SCHEMA.md) — Schéma human memory

## Installation

```bash
cd v2
npm install
npm run build
```

## Prérequis

- Node.js ≥ 18
- Codebase Memory V1 installé et indexé (fournit `<project>.db`)
- Python 3 (pour `better-sqlite3` build, sauf si prebuild-install réussit)

## Utilisation

### 1. Initialiser la config V2

```bash
cbm-v2 init --project my-app
```

Crée/met à jour `.codebase-memory.json` à la racine du repo.

### 2. Sync Obsidian

```bash
# Initialiser le vault
cbm-v2 obsidian init

# Sync double-sens (DB ↔ vault)
cbm-v2 obsidian sync

# Preview sans write
cbm-v2 obsidian sync --dry-run
```

### 3. Créer des notes humaines

```bash
# Créer une ADR
cbm-v2 human create --type ADR --title "ADR-001: Use JWT" --link-cbm 1234 --link-edge DECIDES

# Lister
cbm-v2 human list --type ADR

# Lier une note à un code node
cbm-v2 human link 5 --to-cbm-node 1234 --edge EXPLAINS
```

### 4. Reports

```bash
cbm-v2 report hotspots
cbm-v2 report undocumented
cbm-v2 report risk
```

### 5. Lancer le serveur MCP

```bash
cbm-v2 mcp --project my-app
```

Expose 6 tools MCP sur stdio (JSON-RPC 2.0) :

- `get_project_overview`
- `get_module_context`
- `get_undocumented_hotspots`
- `create_human_note`
- `link_note_to_code_node`
- `search_code_and_memory`

Compatible avec tous les agents MCP (Claude Code, Cursor, Zed, etc.).

## Structure

```
v2/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── human/
    │   ├── schema.ts         # SQL schema + migrations + types
    │   └── store.ts          # CRUD HumanMemoryStore
    ├── obsidian/
    │   ├── frontmatter.ts    # YAML frontmatter + section splitting
    │   ├── wikilinks.ts      # [[wikilink]] parser
    │   ├── vault.ts          # FS helpers + index/template renderers
    │   ├── generator.ts      # DB → vault (préserve HUMAN NOTES)
    │   └── importer.ts       # vault → DB
    ├── bridge/
    │   └── sqlite-ro.ts      # Read-only access to V1 code graph
    ├── reports/
    │   ├── hotspots.ts
    │   ├── undocumented.ts
    │   └── risk.ts
    ├── mcp/
    │   ├── server.ts         # JSON-RPC 2.0 over stdio
    │   └── tools/
    │       ├── index.ts
    │       ├── base.ts
    │       ├── get_project_overview.ts
    │       ├── get_module_context.ts
    │       ├── get_undocumented_hotspots.ts
    │       ├── create_human_note.ts
    │       ├── link_note_to_code_node.ts
    │       └── search_code_and_memory.ts
    └── cli/
        ├── index.ts
        └── commands/
            ├── obsidian.ts
            ├── human.ts
            └── report.ts
```

## Stockage

| Fichier | Rôle |
|---|---|
| `~/.cache/codebase-memory-mcp/<project>.db` | Code graph V1 (géré par le moteur C, **inchangé**) |
| `~/.cache/codebase-memory-mcp/<project>.human.db` | Human memory V2 (nouveau) |
| `<repo>/.codebase-memory-vault/` | Vault Obsidian (Markdown) |
| `<repo>/.codebase-memory.json` | Config projet V2 |

## Sécurité

- **Local-first** : aucun appel réseau sortant
- **HUMAN NOTES inviolables** : la section `## HUMAN NOTES` de chaque note Obsidian
  n'est **jamais** écrasée par V2. Backup `.bak` automatique avant tout write.
- **Dry-run** disponible sur toutes les commandes qui écrivent
- **Audit log** dans `~/.cache/codebase-memory-mcp/v2-audit.log`

## Tests

```bash
npm test
```

## Licence

MIT (même licence que le projet parent Codebase Memory MCP).
