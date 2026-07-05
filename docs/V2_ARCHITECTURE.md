# V2 Architecture — Codebase Memory V2

> Architecture cible de Codebase Memory V2. Ce document décrit la nouvelle
> architecture, les modules internes, le schéma de graphe unifié, le modèle
> Obsidian, le schéma de sync, le design des tools MCP et le design UI.

## 1. Principes directeurs

1. **Additif, pas destructif** — on ne réécrit pas le moteur C. On ajoute une
   couche TypeScript « sidecar » qui s'interface via MCP + SQLite RO.
2. **Local-first** — tout reste sur la machine. Pas d'envoi de code ou notes
   vers API externe sans opt-in explicite.
3. **Mémoire humaine inviolable** — les sections `## HUMAN NOTES` dans le vault
   Obsidian ne sont **jamais** écrasées. Diff + backup avant tout write.
4. **Vues filtrées par défaut** — ne jamais ouvrir sur le graphe complet.
   Toujours commencer par un dashboard d'architecture.
5. **Agrégation côté lecture** — les agents IA récupèrent un contexte complet
   (code + humain) en un seul appel MCP.
6. **Même distribution** — V2 reste distribué comme binaire unique via
   npm/pypi/homebrew. Le sidecar TS est bundlé dans le binaire C (embed assets
   pattern existant).

## 2. Architecture globale

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Codebase Memory V2 — process unique, binaire C + bundle TS              │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ┌────────────────────────────────┐      ┌──────────────────────────┐  │
│   │  C Engine (V1, inchangé)       │      │  TS Sidecar (V2)         │  │
│   │  ──────────────────────────    │      │  ──────────────────────  │  │
│   │  Foundation (mem, log, etc.)   │      │  v2/src/                 │  │
│   │  Store (SQLite code graph)     │      │   ├─ human/              │  │
│   │  Pipeline (158 lang, 22 passes)│      │   │  ├─ schema.ts        │  │
│   │  Cypher engine                 │      │   │  └─ store.ts         │  │
│   │  MCP server (14 tools V1)      │◄────►│   ├─ obsidian/           │  │
│   │  HTTP UI server (127.0.0.1)    │      │   │  ├─ vault.ts          │  │
│   │  React/d3-force UI (V2 2D)     │      │   │  ├─ frontmatter.ts   │  │
│   │  Watcher (polling)             │      │   │  ├─ wikilinks.ts     │  │
│   │  CLI (install, config, etc.)   │      │   │  ├─ generator.ts     │  │
│   │  ──────────────────────────    │      │   │  └─ importer.ts      │  │
│   │  + 7 new MCP tools V2          │      │   ├─ mcp/                │  │
│   │  + New HTTP /api/* routes      │      │   │  ├─ server.ts        │  │
│   │  + New UI tabs (dashboard)     │      │   │  └─ tools/ (7)       │  │
│   │                                │      │   ├─ reports/            │  │
│   │                                │      │   │  ├─ hotspots.ts      │  │
│   │                                │      │   │  ├─ undocumented.ts  │  │
│   │                                │      │   │  └─ risk.ts          │  │
│   │                                │      │   ├─ intelligence/       │  │
│   │                                │      │   │  └─ graph-status.ts  │  │
│   │                                │      │   ├─ ui/                │  │
│   │                                │      │   │  └─ server.ts        │  │
│   │                                │      │   ├─ bridge/             │  │
│   │                                │      │   │  └─ sqlite-ro.ts     │  │
│   │                                │      │   ├─ cli/                │  │
│   │                                │      │   │  └─ commands/        │  │
│   │                                │      │   ├─ config.ts           │  │
│   │                                │      │   ├─ constants.ts        │  │
│   │                                │      │   └─ index.ts            │  │
│   └────────────────────────────────┘      └──────────────────────────┘  │
│                                                                          │
│   ┌──────────────────────────────────────────────────────────────────┐  │
│   │  Stockage (filesystem)                                          │  │
│   │  ─────────────────────────────────────────────────────────────  │  │
│   │  ~/.cache/codebase-memory-mcp/                                  │  │
│   │     <project>.db              ← code graph (V1, inchangé)       │  │
│   │     <project>.human.db        ← human memory (V2)               │  │
│   │     _config.db                ← runtime KV (V1+V2 keys)         │  │
│   │     config.json               ← UI config (V1+V2 keys)          │  │
│   │  <repo>/                                                         │  │
│   │     .codebase-memory/                                           │  │
│   │        graph.db.zst            ← team code artifact (V1)        │  │
│   │        human-memory.db.zst     ← team human artifact (V2 new)   │  │
│   │     .codebase-memory-vault/   ← Obsidian vault (V2)             │  │
│   │        00_Index.md                                              │  │
│   │        Architecture/ ADR/ Modules/ Routes/ Refactor/            │  │
│   │        Bugs/ Legacy/ Conventions/ Prompts/ Journal/             │  │
│   │     .codebase-memory.json      ← project config (V1+V2 keys)    │  │
│   └──────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

> **Note**: L'UI V2 remplace la 3D Three.js de V1 par un canvas 2D d3-force
> (plus simple, pas de GPU, gère 5000+ nodes). Le dashboard est la vue par
> défaut, pas le graphe complet.

## 3. Modules internes (V2 sidecar TypeScript)

| Module | Rôle | Fichiers |
|---|---|---|
| `v2/src/human/` | Human memory DB (SQLite séparé) : schema, CRUD | `schema.ts`, `store.ts` |
| `v2/src/obsidian/` | Génération et sync du vault Markdown | `vault.ts`, `frontmatter.ts`, `wikilinks.ts`, `generator.ts`, `importer.ts` |
| `v2/src/mcp/` | Serveur MCP TypeScript (7 tools V2) | `server.ts`, `tools/*.ts` |
| `v2/src/reports/` | Reports CLI (hotspots, undocumented, risk) | `hotspots.ts`, `undocumented.ts`, `risk.ts` |
| `v2/src/cli/` | CLI commands V2 (`obsidian init/sync/import/export`, `report`, `stats`, `backup`, `demo`, `human`, `mcp`, `ui`, `init`, `doctor`) | `index.ts`, `commands/*.ts` |
| `v2/src/bridge/` | Communication avec le moteur C (SQLite RO direct) | `sqlite-ro.ts` |
| `v2/src/intelligence/` | Graph freshness detection, smart recommendations | `graph-status.ts` |
| `v2/src/ui/` | HTTP server pour le graph UI (127.0.0.1:9749) | `server.ts` |
| `v2/src/config.ts` | Loader pour `.codebase-memory.json` | — |
| `v2/src/constants.ts` | Constantes partagées (thresholds, limits, safeJsonParse) | — |
| `graph-ui/src/` | React + Vite + d3-force 2D canvas | `App.tsx`, `components/*.tsx`, `hooks/*.ts`, `api/*.ts`, `lib/*.ts` |

## 4. Schéma de graphe unifié

### 4.1 Stratégie : deux DBs, jointures à la lecture

On ne fusionne pas les deux graphs dans une seule DB. On garde :

- **Code graph** : `<project>.db` (V1, inchangé, écrit par le moteur C)
- **Human graph** : `<project>.human.db` (V2, écrit par le sidecar TS)

Les jointures se font à la lecture via `cbm_node_id` (clé étrangère du code
graph stockée dans les nodes humaines).

**Avantages** :
- Pas de migration risquée du schéma V1
- Le moteur C continue de tourner sans modification
- Le human graph peut être réinitialisé sans toucher au code graph
- Sauvegarde/restauration indépendants
- Conflits `.db.zst` évités (artefacts séparés)

### 4.2 Code nodes (V1, inchangé)

Voir `V2_AUDIT.md` §3. Aucune modification.

### 4.3 Human nodes (V2, nouveau)

```typescript
type HumanNodeLabel =
  | 'ArchitectureNote'
  | 'ADR'
  | 'BugNote'
  | 'RefactorPlan'
  | 'LegacyNote'
  | 'Convention'
  | 'Prompt'
  | 'JournalEntry'
  | 'ModuleNote'
  | 'RouteNote'
  | 'RiskNote';

interface HumanNode {
  id: number;                  // PK auto
  project: string;             // FK → projects.name (code graph)
  label: HumanNodeLabel;
  title: string;
  body_markdown: string;       // contenu Markdown (sans frontmatter)
  frontmatter_json: string;    // JSON frontmatter sérialisé (pas YAML — voir schema.ts)
  status: 'draft' | 'active' | 'reviewed' | 'deprecated';
  source: 'human' | 'generated' | 'mixed';
  cbm_node_ids: number[];      // liens vers code nodes (JSON array)
  obsidian_path: string;       // chemin relatif dans le vault
  tags: string[];
  provenance: string;          // 'human' | 'generated' | 'mixed'
  confidence: number;          // 0.0 à 1.0
  source_file: string | null;  // chemin du fichier Markdown (si importé)
  author: string | null;
  created_at: string;          // ISO 8601
  updated_at: string;
  last_synced_at: string | null;
}
```

### 4.4 Code edges (V1, inchangé)

Voir `V2_AUDIT.md` §3. Aucune modification.

### 4.5 Human edges (V2, nouveau)

```typescript
type HumanEdgeType =
  | 'EXPLAINS'      // ADR/note explique un code node
  | 'DECIDES'       // ADR décide d'une décision architecturale
  | 'AFFECTS'       // Bug affecte une route/module
  | 'TOUCHES'       // Refactor touche un module/fichier
  | 'DOCUMENTS'     // Note documente un module
  | 'DEPRECATES'    // ADR/legacy deprecate un code node
  | 'REPLACES'      // Refactor remplace un code node
  | 'RISKS'         // Risk pointe un code node fragile
  | 'MENTIONS'      // Note mentionne un code node
  | 'JUSTIFIES'     // ADR justifie un choix de code
  | 'OWNS'          // Convention/propriétaire d'un module
  | 'TODO_FOR';     // Bug/refactor TODO pour un code node

interface HumanEdge {
  id: number;
  project: string;
  source_human_node_id: number;  // FK → human_nodes.id
  target_cbm_node_id: number;    // FK → code graph nodes.id (pas de FK SQLite cross-DB)
  target_kind: 'code' | 'human';
  type: HumanEdgeType;
  properties_json: string;
  created_at: string;
}
```

### 4.6 Métadonnées riches (V2)

Toutes les human nodes et human edges portent :

- `provenance` : `'human'` | `'generated'` | `'mixed'`
- `confidence` : `0.0` à `1.0` (pour les edges générés par LLM/heuristique)
- `source_file` : chemin du fichier Markdown (si importé Obsidian)
- `source_note` : titre de la note source
- `timestamp` : ISO 8601
- `author` : optionnel (Git author, ou username local)

## 5. Modèle Obsidian

Voir `OBSIDIAN_INTEGRATION.md` pour le détail. Synthèse ici :

- Vault à `<repo>/.codebase-memory-vault/`
- Structure : `Architecture/`, `ADR/`, `Modules/`, `Routes/`, `Refactor/`,
  `Bugs/`, `Legacy/`, `Conventions/`, `Prompts/`, `Journal/`
- Chaque note : frontmatter YAML + `## AUTO-GENERATED` + `## HUMAN NOTES`
- Wikilinks `[[<cbm_node_id>]]` et `[[<human_node_id>]]` résolus à la sync
- Tags Obsidian pour filtrage : `#type/adr`, `#status/active`, `#module/auth`, etc.

## 6. Schéma de sync Obsidian

### 6.1 Sync双向

```
                     ┌───────────────────────────┐
                     │   Code Graph (V1 SQLite)  │
                     └────────────┬──────────────┘
                                  │ (lecture via bridge)
                                  ▼
                     ┌───────────────────────────┐
                     │   Human Memory DB (V2)    │
                     │   ──────────────────────  │
                     │   human_nodes             │
                     │   human_edges             │
                     │   schema_migrations       │
                     └────────────┬──────────────┘
                                  │
                ┌─────────────────┴─────────────────┐
                │                                   │
                ▼                                   ▼
   ┌────────────────────────┐         ┌────────────────────────┐
   │   Obsidian Vault (FS)  │         │   MCP tools (15 new)   │
   │   ──────────────────   │         │   ──────────────────   │
   │   <vault>/             │         │   get_* (lecture)      │
   │     *.md (frontmatter) │◄───────►│   create_* (écriture)  │
   │     [[wikilinks]]      │         │   link_* (edges)       │
   │     #tags              │         │   report_* (analytics) │
   └────────────────────────┘         └────────────────────────┘
```

### 6.2 Direction sync → vault (export)

1. Lire tous les `human_nodes` + leurs `cbm_node_ids` liés
2. Pour chaque node, calculer le chemin vault (`Modules/<name>.md`, etc.)
3. Si le fichier existe :
   - Lire son contenu
   - Parser le frontmatter YAML
   - Séparer `## AUTO-GENERATED` et `## HUMAN NOTES`
   - Régénérer `## AUTO-GENERATED` à partir du DB
   - **Préserver `## HUMAN NOTES`** à l'identique
   - Backup `.bak` si modification
   - Write
4. Si le fichier n'existe pas : créer avec template complet

### 6.3 Direction vault → sync (import)

1. Walk récursif du vault
2. Pour chaque `.md` :
   - Parser frontmatter
   - Extraire `cbm_node_id`, `cbm_node_type` si présents
   - Parser `## HUMAN NOTES` section
   - Upsert dans `human_nodes` (merge par `obsidian_path` ou `cbm_node_id`)
3. Pour chaque `[[wikilink]]` trouvé :
   - Résoudre vers `cbm_node_id` ou `human_node_id`
   - Créer `human_edges` correspondants (`MENTIONS`, `EXPLAINS`, etc.)

### 6.4 Détection de conflits

- Si une note a une `## HUMAN NOTES` modifiée depuis le dernier sync, on
  préserve la version humaine.
- Si une note a été supprimée du vault, on marque `human_nodes.obsidian_path = NULL`
  mais on garde le record (soft delete).
- Si une note a été supprimée du DB mais existe dans le vault, on demande
  confirmation à l'utilisateur avant import.

## 7. Design des tools MCP V2 (7 implémentés, 8 planifiés)

Tous les tools V2 vivent dans `v2/src/mcp/tools/`. Ils sont exposés via le
serveur MCP TypeScript qui tourne en parallèle du moteur C.

> **Note**: L'architecture cible prévoyait 15 tools. Actuellement 7 sont implémentés
> (version 0.7.0). Les 8 restants sont planifiés pour les phases 2-3 (voir V2_ROADMAP.md).

| # | Tool | Type | Statut | Description |
|---|---|---|---|---|
| 1 | `get_project_overview` | lecture | ✅ Implémenté | Résumé exécutif : nb modules, routes, ADRs, bugs, hotspots, dette technique |
| 2 | `get_module_context` | lecture | ✅ Implémenté | Contexte complet d'un module : code nodes + human notes + ADR + bugs + refactors liés |
| 3 | `get_undocumented_hotspots` | lecture | ✅ Implémenté | Modules/routes/fonctions centrales SANS note humaine |
| 4 | `create_human_note` | écriture | ✅ Implémenté | Crée une note humaine (ADR, BugNote, etc.) + link à un code node |
| 5 | `link_note_to_code_node` | écriture | ✅ Implémenté | Crée un human edge entre une note et un code node |
| 6 | `search_code_and_memory` | lecture | ✅ Implémenté | Recherche unifiée : BM25 sur code + LIKE sur human + fusion |
| 7 | `prepare_edit_context` ⭐ | lecture | ✅ Implémenté | **Flagship** — context complet avant édition d'un fichier (code + human + blast radius + risk + freshness) |
| 8 | `get_architecture_dashboard` | lecture | 🔜 Planifié | KPIs d'architecture : modules critiques, zones à risque, doc coverage, legacy |
| 9 | `get_route_flow` | lecture | 🔜 Planifié | Flow d'une route HTTP : handler → service → repo → external calls + notes humaines |
| 10 | `get_blast_radius` | lecture | 🔜 Planifié | Impact direct + indirect d'un symbol : routes affectées, tests, notes, ADR |
| 11 | `get_human_notes_for_node` | lecture | 🔜 Planifié | Toutes les notes humaines liées à un code node (cbm_node_id) |
| 12 | `get_related_adrs` | lecture | 🔜 Planifié | ADRs qui DECIDES/AFFECTS/TOUCHES un code node |
| 13 | `get_related_bugs` | lecture | 🔜 Planifié | Bugs qui AFFECTS un module/route/symbol |
| 14 | `get_refactor_plans` | lecture | 🔜 Planifié | Refactors qui TOUCHES/REPLACES un code node |
| 15 | `update_human_note` | écriture | 🔜 Planifié | Met à jour le body d'une note existante (préserve HUMAN NOTES) |

### 7.1 Schéma d'input/output (exemple : `get_module_context`)

**Input** :
```json
{
  "project": "my-app",
  "module_name": "auth",
  "include_code": true,
  "include_human": true,
  "include_adrs": true,
  "include_bugs": true,
  "include_refactors": true,
  "depth": 2
}
```

**Output** :
```json
{
  "module": {
    "cbm_node_id": 1234,
    "name": "auth",
    "qualified_name": "my-app.src.auth",
    "file_path": "src/auth/index.ts",
    "lines": 450,
    "complexity_avg": 8.2,
    "degree": 47
  },
  "code_nodes": [
    { "id": 1235, "label": "Function", "name": "login", "file_path": "...", "complexity": 12 }
  ],
  "human_notes": [
    { "id": 1, "label": "ModuleNote", "title": "Auth module - overview", "status": "active" }
  ],
  "adrs": [
    { "id": 2, "label": "ADR", "title": "ADR-003: Use JWT for sessions", "status": "active" }
  ],
  "bugs": [],
  "refactors": [
    { "id": 5, "label": "RefactorPlan", "title": "Extract SessionProvider", "status": "active" }
  ],
  "stats": {
    "documentation_coverage": 0.65,
    "risk_score": 0.42
  }
}
```

### 7.2 Objectif agent IA

Quand un agent travaille sur `src/auth/login.ts`, il appelle un seul tool :

```
get_module_context(project="my-app", module_name="auth")
```

Et récupère : la structure réelle du code, le contexte humain (notes, ADR),
les bugs connus, les refactors prévus, le risk score. **Pas besoin de 5
appels séparés.**

## 8. Design UI V2

### 8.1 Nouveau default : Architecture Dashboard

Au lieu d'ouvrir sur le graphe complet, l'UI ouvre sur un dashboard
d'architecture qui affiche :

- KPIs : nb modules, routes, ADRs, bugs, hotspots, dette
- Top 10 modules critiques (par degré + complexité)
- Top 10 zones à risque (coupling + undocumented)
- Documentation coverage par module
- Routes sans note
- Modules legacy non documentés
- Refactors prévus

### 8.2 Vues ajoutées

| Vue | Description | Composant React |
|---|---|---|
| Architecture Dashboard | KPIs + listes top | `ArchitectureDashboard.tsx` |
| Module Ego Graph | 1 module au centre + dépendances + notes | `ModuleEgoGraph.tsx` |
| Route Flow View | Route → handler → service → repo → external | `RouteFlowView.tsx` |
| Blast Radius View | Impact direct + indirect d'un symbol | `BlastRadiusView.tsx` |
| Human Memory Overlay | Notes Obsidian sur le graphe | `HumanMemoryOverlay.tsx` |
| Documentation Coverage | Heatmap modules × documentation | `DocumentationCoverage.tsx` |
| Risk Dashboard | High coupling, dead code, fragile interfaces | `RiskDashboard.tsx` |

### 8.3 Modifications UI existante

- `App.tsx` `TabId` : ajouter `"dashboard"`, `"notes"`, `"memory"`, `"decisions"`. Default = `"dashboard"`.
- `useGraphData.ts` `fetchDetail()` : implémenter le vrai subgraph expansion
  centré sur un nœud (pas un stub). Appel : `GET /api/subgraph?project=...&center=<cbm_node_id>&depth=2&max_nodes=200`.
- `GraphTab.tsx` : default filters à `["Module", "Route"]` au lieu de tous.
- Nouveau endpoint HTTP : `GET /api/human-notes?project=...&cbm_node_id=...`.

## 9. Config système V2

### 9.1 Nouveau fichier `.codebase-memory.json` (étendu)

```json
{
  "projectName": "MyProject",
  "root": ".",
  "exclude": ["node_modules", "dist", ".git"],
  "v2": {
    "enabled": true,
    "humanMemory": {
      "enabled": true,
      "dbPath": "~/.cache/codebase-memory-mcp/<project>.human.db"
    },
    "obsidian": {
      "enabled": true,
      "vaultPath": ".codebase-memory-vault",
      "preserveHumanSections": true,
      "autoGenerateModuleNotes": true,
      "autoGenerateRouteNotes": true,
      "minDegreeForModuleNote": 20,
      "backupBeforeWrite": true,
      "wikilinksFormat": "cbm_node_id"
    },
    "ui": {
      "defaultView": "architecture-dashboard",
      "maxInitialNodes": 500
    },
    "privacy": {
      "localOnly": true,
      "telemetry": false
    },
    "mcp": {
      "exposeV2Tools": true,
      "maxContextNodes": 200
    }
  }
}
```

### 9.2 Nouvelles clés KV dans `_config.db`

- `v2_enabled` (bool, default `true`)
- `v2_human_memory_enabled` (bool)
- `v2_obsidian_enabled` (bool)
- `v2_default_view` (string, default `"architecture-dashboard"`)
- `v2_telemetry` (bool, default `false`)

## 10. Système de plugins (post-MVP)

### 10.1 C ABI pour extracteurs tiers

```c
typedef struct {
    uint32_t abi_version;
    const char *name;
    const char *version;
    int (*init)(const char *config_json);
    int (*extract)(cbm_gbuf_t *gbuf, const char *file_path, const char *source, size_t source_len);
    void (*shutdown)(void);
} cbm_extractor_v1;
```

### 10.2 Chargement

- Répertoire : `~/.config/codebase-memory-mcp/plugins/`
- Découverte : `dlopen` sur `.so`/`.dylib`/`.dll`, lookup `cbm_extractor_v1_export`
- Hook dans `pipeline.c` pass_definitions : après extraction native, itère
  plugins

## 11. Système de migrations (human DB)

```sql
CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);
```

Chaque migration est un fichier TypeScript dans
`v2/src/human/migrations/<n>_<name>.ts` exportant `up(sqlite)` et `down(sqlite)`.

## 12. Backup, snapshot, export/import

- **Backup Obsidian** avant write : `.bak` timestampé
- **Snapshot human DB** : `cbm human snapshot` → `<project>.human.db.<ts>.bak`
- **Export JSON** : `cbm human export --output human-memory.json`
- **Import JSON** : `cbm human import --input human-memory.json` (merge par
  `obsidian_path` ou `title`)

## 13. Mode offline / privacy

- `localOnly: true` par défaut
- Aucun appel réseau sortant depuis le sidecar TS
- `telemetry: false` par défaut
- Logs audités dans `~/.cache/codebase-memory-mcp/v2-audit.log`
- `dry-run` flag pour `obsidian sync` : `cbm obsidian sync --dry-run`

## 14. Performance V2

- **Lazy loading UI** : ne charger que les 500 premiers nœuds par défaut
- **Graph clustering** : pré-calculer clusters Leiden à l'indexation, stocker
  dans `nodes.cluster_id`
- **Filtered queries** : tous les tools V2 acceptent `limit` + `offset`
- **Indexing incrémental** : le human DB supporte l'upsert par `obsidian_path`
- **Cache des métriques** : `documentation_coverage`, `risk_score` pré-calculés
  dans `human_metrics` table, invalidés à chaque write
- **Pagination** : tous les tools retour au max 200 résultats
- **Worker threads** : génération vault en worker pour ne pas bloquer MCP
- **Subgraph expansion** : BFS avec cap à 500 nœuds, pas de recursion
  incontrôlée

## 15. Compatibilité ascendante

- V2 détecte V1 (présence de `<project>.db`) et active le sidecar automatiquement
- V2 fonctionne sans V1 (mode "human memory only") si `v2.humanMemory.enabled = true`
  et code graph absent
- Les configs V1 continuent de fonctionner (clés inconnues ignorées)
- Les 14 tools MCP V1 restent disponibles
- L'UI V2 détecte l'absence de human DB et désactive les tabs `notes`/`memory`
