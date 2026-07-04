# V2 Roadmap — Codebase Memory V2

> Roadmap de livraison. Trois phases : MVP → V1 (complète) → V2 (étendue).
> Chaque phase a des critères d'acceptation mesurables.

## Vue d'ensemble

| Phase | Périmètre | Durée estimée | Critère de sortie |
|---|---|---|---|
| **MVP** | Audit + docs + human memory + Obsidian vault + 6 MCP tools + reports | Itération initiale | Toutes les critères §1.5 validés |
| **V1 complète** | Toutes les 15 MCP tools + 7 vues UI + plugin system | Itération suivante | Toutes les vues UI opérationnelles |
| **V2 étendue** | Multi-user / remote / plugin ecosystem / streaming | Post-V1 | Optionnel, basé sur demande |

---

## Phase 0 — Audit et documentation (✅ réalisé ici)

| Livrable | Statut |
|---|---|
| `docs/V2_AUDIT.md` | ✅ |
| `docs/V2_ARCHITECTURE.md` | ✅ |
| `docs/V2_ROADMAP.md` | ✅ (ce document) |
| `docs/OBSIDIAN_INTEGRATION.md` | ✅ |
| `docs/HUMAN_MEMORY_GRAPH_SCHEMA.md` | ✅ |
| Liste de fichiers à modifier | ✅ (§4 ci-dessous) |
| Liste de modules à remplacer | ✅ (§5 ci-dessous) |
| Proposition de branche Git | ✅ (§6 ci-dessous) |
| Plan de commits progressifs | ✅ (§7 ci-dessous) |

---

## Phase 1 — MVP

### 1.1 Objectif

Livrer une V2 fonctionnelle où :

1. L'indexation de code V1 continue de marcher à l'identique
2. Un vault Obsidian peut être généré, lu, édité, re-syncé
3. Les notes humaines sont stockées dans un DB dédié
4. Les zones `## HUMAN NOTES` ne sont **jamais** écrasées
5. Les notes humaines peuvent être liées à des code nodes
6. Un agent IA peut récupérer un contexte riche en un appel

### 1.2 Périmètre technique MVP

#### Modules V2 à implémenter

| Module | Fichiers | LOC estimées |
|---|---|---|
| `v2/src/human/schema.ts` | SQLite schema + migrations | ~150 |
| `v2/src/human/store.ts` | CRUD human nodes + edges | ~400 |
| `v2/src/human/importer.ts` | Import JSON / Obsidian → DB | ~250 |
| `v2/src/human/exporter.ts` | Export DB → JSON | ~150 |
| `v2/src/obsidian/frontmatter.ts` | YAML frontmatter parse/serialize | ~200 |
| `v2/src/obsidian/wikilinks.ts` | `[[wikilink]]` parser/resolver | ~150 |
| `v2/src/obsidian/generator.ts` | DB → vault (avec sections HUMAN NOTES préservées) | ~400 |
| `v2/src/obsidian/importer.ts` | vault → DB | ~300 |
| `v2/src/obsidian/vault.ts` | Vault FS helpers (walk, ensure dirs) | ~150 |
| `v2/src/bridge/sqlite-ro.ts` | Lecture read-only du code graph V1 | ~250 |
| `v2/src/bridge/c-engine.ts` | Appel MCP au moteur C (via stdio subprocess) | ~200 |
| `v2/src/reports/hotspots.ts` | Modules critiques + centralité | ~200 |
| `v2/src/reports/undocumented.ts` | Modules/routes/fonctions sans note | ~200 |
| `v2/src/reports/risk.ts` | High coupling + dead code + fragile | ~250 |
| `v2/src/mcp/server.ts` | Serveur MCP TypeScript (JSON-RPC over stdio) | ~300 |
| `v2/src/mcp/tools/*.ts` | 6 tools MVP (voir §1.3) | ~800 |
| `v2/src/cli/commands/obsidian.ts` | `obsidian init/sync/import/export` | ~300 |
| `v2/src/cli/commands/report.ts` | `report hotspots/undocumented/risk` | ~150 |
| `v2/src/cli/commands/human.ts` | `human create/list/show/link` | ~250 |
| `v2/src/cli/index.ts` | Entry point, dispatch | ~150 |
| `v2/package.json` | Dépendances (better-sqlite3, yaml, commander) | — |
| `v2/tsconfig.json` | TypeScript strict | — |
| **Total** | | **~5 000 LOC TS** |

#### Outils / dépendances V2

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^11.0.0",
    "yaml": "^2.5.0",
    "commander": "^12.0.0",
    "gray-matter": "^4.0.3",
    "fast-glob": "^3.3.0",
    "marked": "^14.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0",
    "@types/better-sqlite3": "^7.6.0",
    "vitest": "^2.0.0",
    "tsx": "^4.0.0"
  }
}
```

### 1.3 MCP tools MVP (6 sur 15)

| # | Tool | Type | MVP ? |
|---|---|---|---|
| 1 | `get_project_overview` | lecture | ✅ |
| 2 | `get_module_context` | lecture | ✅ |
| 3 | `get_undocumented_hotspots` | lecture | ✅ |
| 4 | `create_human_note` | écriture | ✅ |
| 5 | `link_note_to_code_node` | écriture | ✅ |
| 6 | `search_code_and_memory` | lecture | ✅ |
| 7-15 | autres tools | — | ⏳ V1 complète |

### 1.4 CLI commands MVP

```bash
# Obsidian
cbm-v2 obsidian init                  # crée .codebase-memory-vault/ + structure
cbm-v2 obsidian sync                  # sync双向 DB ↔ vault
cbm-v2 obsidian sync --dry-run        # preview sans write
cbm-v2 obsidian export                # export DB → vault (one-shot)
cbm-v2 obsidian import                # import vault → DB (one-shot)

# Reports
cbm-v2 report hotspots                # modules critiques
cbm-v2 report undocumented            # sans note humaine
cbm-v2 report risk                    # high coupling + dead code

# Human memory
cbm-v2 human create --type ADR --title "ADR-001: ..." --module auth
cbm-v2 human list --type BugNote --module auth
cbm-v2 human show <id>
cbm-v2 human link <note-id> --to-cbm-node <cbm-node-id> --edge EXPLAINS

# Init
cbm-v2 init                           # crée .codebase-memory.json avec defaults V2
```

### 1.5 Critères d'acceptation MVP

| # | Critère | Comment vérifier |
|---|---|---|
| 1 | Le projet Codebase Memory V1 démarre correctement | `cbm list-projects` répond |
| 2 | L'indexation de code V1 fonctionne | `cbm index_repository` sur un repo de test |
| 3 | Un vault Obsidian peut être généré | `cbm-v2 obsidian init && cbm-v2 obsidian export` produit des `.md` |
| 4 | Les notes Markdown sont lisibles dans Obsidian | Ouvrir le vault dans Obsidian, naviguer |
| 5 | Les zones `## HUMAN NOTES` ne sont jamais écrasées | Modifier une note, re-sync, vérifier la section préservée |
| 6 | Les notes humaines peuvent être importées comme nodes | `cbm-v2 obsidian import` crée des `human_nodes` |
| 7 | Un module critique peut être lié à une note humaine | `cbm-v2 human link` crée un `human_edge` |
| 8 | Une ADR peut être liée à un module ou une route | Idem via `create_human_note` |
| 9 | Un agent MCP peut demander un overview projet | `get_project_overview` retourne JSON |
| 10 | Un agent MCP peut demander le contexte d'un module | `get_module_context` retourne code + humain |
| 11 | Un agent MCP peut lister les hotspots non documentés | `get_undocumented_hotspots` retourne liste |
| 12 | La CLI peut montrer les zones critiques sans doc | `cbm-v2 report undocumented` |

### 1.6 Tests MVP

- Tests unitaires : `v2/tests/human/store.test.ts`, `obsidian/generator.test.ts`,
  `obsidian/importer.test.ts`, `obsidian/frontmatter.test.ts`,
  `mcp/tools/*.test.ts`
- Tests d'intégration : `tests/integration/obsidian-sync.test.ts`,
  `tests/integration/mcp-tools.test.ts`
- Tests de non-régression : `tests/regression/human-notes-preserved.test.ts`
- Tests V1 non cassés : la suite C (5 604 tests) doit continuer à passer

---

## Phase 2 — V1 complète

### 2.1 Objectif

Compléter tous les tools MCP (15), toutes les vues UI (7), et le plugin system.

### 2.2 Périmètre

#### MCP tools V1 (9 restants)

- `get_architecture_dashboard`
- `get_route_flow`
- `get_blast_radius`
- `get_human_notes_for_node`
- `get_related_adrs`
- `get_related_bugs`
- `get_refactor_plans`
- `update_human_note`
- `create_adr`

#### Vues UI (7)

- `ArchitectureDashboard.tsx`
- `ModuleEgoGraph.tsx` (implémente vrai `fetchDetail`)
- `RouteFlowView.tsx`
- `BlastRadiusView.tsx`
- `HumanMemoryOverlay.tsx`
- `DocumentationCoverage.tsx`
- `RiskDashboard.tsx`

#### Modifications UI existante

- `App.tsx` `TabId` : ajouter `"dashboard"`, `"notes"`, `"memory"`, `"decisions"`. Default = `"dashboard"`.
- `useGraphData.ts` `fetchDetail()` : implémenter (call `/api/subgraph`).
- `GraphTab.tsx` : default filters à `["Module", "Route"]`.

#### Nouveaux endpoints HTTP (côté C)

- `GET /api/human-notes?project=...&cbm_node_id=...`
- `GET /api/subgraph?project=...&center=<id>&depth=2&max_nodes=200`
- `GET /api/architecture-dashboard?project=...`
- `GET /api/documentation-coverage?project=...`
- `GET /api/risk-dashboard?project=...`
- `POST /api/human-notes` (création)
- `PUT /api/human-notes/<id>` (update avec préservation HUMAN NOTES)
- `GET /api/obsidian/status?project=...`

#### Plugin system

- C ABI `cbm_extractor_v1`
- `dlopen` loader dans `pipeline.c`
- Plugin discovery `~/.config/codebase-memory-mcp/plugins/`

#### Complétion V1 existant

- `ingest_traces` : implémenter le stub (écriture de `CALLS` edges depuis traces runtime)

### 2.3 Critères d'acceptation V1 complète

| # | Critère |
|---|---|
| 1 | Tous les 15 tools MCP répondent |
| 2 | Toutes les 7 vues UI s'affichent sans crash |
| 3 | L'UI s'ouvre par défaut sur le dashboard d'architecture |
| 4 | Cliquer sur un module ouvre l'Ego Graph centré |
| 5 | Le blast radius d'un symbol est calculé en < 1 s |
| 6 | Documentation coverage s'affiche par module |
| 7 | Risk dashboard liste high coupling + dead code |
| 8 | Plugin system charge un extracteur `.so` de test |
| 9 | `ingest_traces` écrit des `CALLS` edges runtime |
| 10 | Aucun des 5 604 tests V1 ne casse |

---

## Phase 3 — V2 étendue (optionnel)

### 3.1 Multi-user / remote store

- Backend optionnel HTTP graph store (DuckDB / Postgres + Apache Age)
- Sync multi-user avec CRDT pour human memory
- Authentification (token / OAuth)

### 3.2 Streaming MCP

- MCP responses en stream NDJSON pour gros contextes
- Pagination native côté UI

### 3.3 Plugin ecosystem

- Marketplace de plugins
- Plugins TypeScript (via `worker_threads`) en plus des plugins C
- Hooks scripting Lua

### 3.4 LSP coverage

- Étendre le LSP custom aux 147 langages restants (peut être communautaire)

### 3.5 Real-time UI

- WebSocket UI updates quand le watcher ré-indexe
- Notifications de changements

---

## Priorités MVP

| Priorité | Item | Raison |
|---|---|---|
| P0 | Human memory DB + schema | Sans ça, rien ne tient |
| P0 | Obsidian vault generator avec HUMAN NOTES préservées | Critère d'acceptation #5 |
| P0 | Bridge SQLite RO vers code graph V1 | Tous les tools en dépendent |
| P0 | `get_module_context` MCP tool | Démo agent IA flagship |
| P0 | `get_undocumented_hotspots` MCP tool | Démo analytics flagship |
| P0 | `cbm-v2 obsidian sync` CLI | Démo workflow flagship |
| P1 | `create_human_note` + `link_note_to_code_node` MCP tools | Démo écriture |
| P1 | `search_code_and_memory` MCP tool | Démo recherche unifiée |
| P1 | `cbm-v2 report hotspots/undocumented/risk` CLI | DX |
| P2 | `get_project_overview` MCP tool | Bonus |
| P2 | `cbm-v2 init` interactive | DX |

---

## Risques et mitigations

| Risque | Probabilité | Impact | Mitigation |
|---|---|---|---|
| Better-sqlite3 ne compile pas sur certaines plateformes | Moyen | Élevé | Précompiler via prebuild-install, fallback à `sql.js` (WASM) |
| Conflit de versions `@modelcontextprotocol/sdk` entre V1 (C) et V2 (TS) | Faible | Moyen | Le moteur C n'utilise pas le SDK TS ; pas de conflit possible |
| Écrasement accidentel de HUMAN NOTES | Faible | Critique | Backup `.bak` automatique + tests de non-régression |
| Perfs sur 15k+ nodes avec jointures code ↔ human | Moyen | Moyen | Index sur `cbm_node_ids` (JSON array → table de jointure) |
| Vault Obsidian trop gros pour git | Faible | Faible | `.gitignore` le vault par défaut, opt-in commit |
| Migration schéma human DB casse les données existantes | Faible | Élevé | Migrations versionnées + backup auto avant migrate |
| Distribution : le sidecar TS alourdit le binaire | Moyen | Moyen | Bundle TS → single JS file via esbuild + embed dans binaire C |
| Token/notes partent vers un LLM externe | Faible | Critique | `localOnly: true` par défaut, audit log |

---

## Critères d'acceptation V2 (finale)

| # | Critère | Phase |
|---|---|---|
| 1 | Codebase Memory V1 démarre | MVP |
| 2 | Indexation de code fonctionne | MVP |
| 3 | Vault Obsidian généré | MVP |
| 4 | Notes lisibles dans Obsidian | MVP |
| 5 | HUMAN NOTES jamais écrasées | MVP |
| 6 | Notes humaines importées comme nodes | MVP |
| 7 | Module critique lié à une note | MVP |
| 8 | ADR liée à module/route | MVP |
| 9 | MCP `get_project_overview` marche | MVP |
| 10 | MCP `get_module_context` marche | MVP |
| 11 | MCP `get_undocumented_hotspots` marche | MVP |
| 12 | CLI report undocumented marche | MVP |
| 13-22 | Tous les 15 MCP tools marchent | V1 complète |
| 23-29 | Toutes les 7 vues UI marchent | V1 complète |
| 30 | UI default = dashboard | V1 complète |
| 31 | Ego Graph centré sur module | V1 complète |
| 32 | Blast radius < 1 s | V1 complète |
| 33 | Plugin system charge `.so` | V1 complète |
| 34 | `ingest_traces` complet | V1 complète |
| 35 | 5 604 tests V1 toujours verts | Toutes phases |
