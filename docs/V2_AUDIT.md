# V2 Audit — Codebase Memory MCP (V1)

> Document de référence pour la conception de Codebase Memory V2.
> Analyse critique de l'existant, identification des limites, et décisions
> sur ce qu'il faut conserver, modifier, remplacer ou ajouter.

## 0. Avertissement important sur la stack

Le brief original mentionnait un projet « TypeScript/Node.js ». **C'est inexact.**
Le dépôt `DeusData/codebase-memory-mcp` est un **codebase C11 pur** (~65 620 LOC
écrits à la main, ~37 M LOC de grammars tree-sitter vendored), avec une UI
React/Three.js séparée (~3 528 LOC TypeScript). La distribution se fait comme
**binaire unique** via npm/pypi/homebrew/scoop/winget/chocolatey/AUR/go install.

Toute la planification V2 doit s'appuyer sur cette réalité, et non sur un
runtime Node.js hypothétique.

## 1. Stack technique réelle

### 1.1 Moteur C

| Domaine | Technologie |
|---|---|
| Langage | C11 (`-std=c11 -D_DEFAULT_SOURCE -D_GNU_SOURCE`) |
| Allocateur | mimalloc (vendored, `MI_OVERRIDE=1` en prod, 50 % RAM max) |
| JSON | yyjson (vendored) |
| Hashing | xxHash (vendored) |
| DB | SQLite 3 (vendored, amalgamation, WAL, mmap 64 MB) |
| Compression | LZ4 HC (indexation) + zstd 1.5.7 (artefact équipe) |
| Parsing | tree-sitter runtime + 158 grammars vendored |
| Git | libgit2 optionnel, fallback `popen("git log …")` |
| Pattern matching | Aho-Corasick custom (routes HTTP, channels, 8 langages) |
| MCP SDK | **aucun** — JSON-RPC 2.0 codé main (`src/mcp/mcp.c`, 5 906 LOC) |

### 1.2 UI (`graph-ui/`)

| Domaine | Technologie |
|---|---|
| Framework | React 19 + TypeScript 5.7 (strict) |
| Build | Vite 6 |
| 3D | @react-three/fiber 9.5 + @react-three/drei 10.7 + three 0.183 |
| Styling | Tailwind CSS 4 |
| UI primitives | radix-ui 1.4, lucide-react |
| Tests | vitest 4 + @testing-library/react + jsdom |

### 1.3 Distribution

Makefile.cbm (772 LOC), CI GitHub Actions avec SLSA 3 provenance, OpenSSF
Scorecard, scan VirusTotal à chaque release. Cinq mille six cent quatre tests
passent selon le README.

## 2. Structure de `src/` (15 sous-dossiers, 122 fichiers)

```
src/
├── main.c                    (682)  entrypoint, dispatch CLI, threads MCP/watcher/UI
├── foundation/               (43 fichiers, 5 778 LOC)  arena, slab, mimalloc, hash_table, str_intern, yaml, compat FS/thread/regex, log, profile, diagnostics, dump_verify
├── mcp/                      (2 fichiers, 6 059 LOC)   serveur JSON-RPC, 14 tools
├── cli/                      (5 fichiers, 5 648 LOC)   install/uninstall/update/config/hook-augment, détection 12 agents
├── store/                    (2 fichiers, 7 120 LOC)   SQLite, WAL, FTS5, bulk write, integrity check
├── pipeline/                 (37 fichiers, 22 801 LOC) 7 stages, 22 passes, incremental, worker pool
├── cypher/                   (2 fichiers, 4 851 LOC)   sous-ensemble Cypher (MATCH/WHERE/RETURN/ORDER BY/LIMIT/SKIP/UNION/UNWIND/WITH/CASE/EXISTS/aggregates)
├── discover/                 (6 fichiers, 3 046 LOC)   walk, gitignore, lang mapping, user config
├── git/                      (2 fichiers, 448 LOC)     git context (branch, HEAD, dirty)
├── graph_buffer/             (2 fichiers, 1 884 LOC)   buffer RAM avec IDs atomiques, merge, dump-to-sqlite
├── semantic/                 (4 fichiers, 2 389 LOC)   TF-IDF, Random Indexing, MinHash, API/Type/Decorator signatures, AST profile, data flow, graph diffusion, Halstead
├── simhash/                  (2 fichiers, 655 LOC)     MinHash K=64 pour SIMILAR_TO
├── traces/                   (2 fichiers, 214 LOC)     ingestion runtime traces (PARTIEL)
├── ui/                       (10 fichiers, 3 390 LOC)  HTTP server 127.0.0.1:9749, single-threaded, embedded assets
└── watcher/                  (2 fichiers, 655 LOC)     polling adaptatif (5 s base + 1 s/500 fichiers, cap 60 s)
```

## 3. Modèle de données actuel

### 3.1 Node

```c
typedef struct {
    int64_t id;
    const char *project;
    const char *label;          /* Function, Method, Class, Interface, Type, Module, File, Folder, Package, Route, Resource, Channel, Enum... */
    const char *name;
    const char *qualified_name;
    const char *file_path;
    int start_line, end_line;
    const char *properties_json;
} cbm_node_t;
```

### 3.2 Edge

```c
typedef struct {
    int64_t id;
    const char *project;
    int64_t source_id, target_id;
    const char *type;           /* CALLS, HTTP_CALLS, IMPORTS, IMPLEMENTS, INHERITS, DECORATES, USES, TYPE_REF, DATA_FLOWS, EMITS, LISTENS_ON, SIMILAR_TO, SEMANTICALLY_RELATED, CROSS_*, COMMITTED_BY */
    const char *properties_json;
} cbm_edge_t;
```

### 3.3 Métadonnées enrichies (dans `properties_json`)

`signature, return_type, receiver, docstring, parent_class, decorators[],
base_classes[], param_names[], param_types[], return_types[], route_path,
route_method, complexity (cyclomatic), cognitive, loop_count, loop_depth,
is_recursive, param_count, max_access_depth, linear_scan_in_loop,
alloc_in_loop, recursion_in_loop, unguarded_recursion, lines, fingerprint
(MinHash K=64), is_exported, is_abstract, is_test, is_entry_point,
structural_profile (25 floats AST), body_tokens`

### 3.4 Labels supportés (V1)

`Function, Method, Class, Interface, Module, File, Folder, Package, Route,
Variable, Resource (K8s), Channel` — et c'est tout. **Aucun label humain**
(ADR, BugNote, RefactorPlan, Convention, etc.) n'existe.

### 3.5 Edge types supportés (V1)

Calls/Structure/Similarity/Cross-repo/VCS — voir audit détaillé. **Aucun edge
humain** (EXPLAINS, DECIDES, AFFECTS, etc.) n'existe.

## 4. Stockage

- **SQLite par projet** : `~/.cache/codebase-memory-mcp/<project>.db`
- Tables : `projects`, `nodes`, `edges`, `file_hashes`, `project_summaries`
- FTS5 virtual table pour BM25 (tokenizer `cbm_camel_split`)
- WAL + `synchronous=NORMAL` (OFF pendant bulk write)
- mmap 64 MB (tunable `CBM_SQLITE_MMAP_SIZE`)
- 3 modes d'ouverture : memory (test), path (RW), path_query (RO, ne crée jamais)
- Bulk write : `begin_bulk()` drop indexes + sync OFF + cache large → `end_bulk()` recreate
- Integrity check automatique → delete + re-index si corruption
- **Artefact équipe** : `<repo>/.codebase-memory/graph.db.zst` (dump SQLite compressé zstd)
- **Config runtime** : `~/.cache/codebase-memory-mcp/_config.db` (KV SQLite)
- **Config UI** : `~/.cache/codebase-memory-mcp/config.json` (`ui_enabled`, `ui_port`)
- **Config user global** : `$XDG_CONFIG_HOME/codebase-memory-mcp/config.json` (`extra_extensions`)
- **Config projet** : `<repo>/.codebase-memory.json` (idem, surcharge global)

## 5. UI — problèmes confirmés

1. **Tout le graphe est affiché par défaut** : `GraphTab.tsx` lignes 49-64
   initialise `enabledLabels` et `enabledEdgeTypes` à **tous** les labels/types
   présents dans les données. Pas de progressive disclosure.
2. **Cap hard à 2 000 nodes** (`GRAPH_RENDER_NODE_LIMIT = 2000` dans
   `useGraphData.ts`). Les grands graphes sont tronqués silencieusement.
3. **`fetchDetail()` est un stub** : la fonction existe mais le body appelle
   juste `fetchLayout(project)` avec un TODO commenté. Pas d'expansion de
   sous-graphe centré sur un nœud.
4. **HTTP server single-threaded** (`src/ui/httpd.c` explicite : pas de thread
   pool). Un client lent bloque le loop jusqu'à 5 s.
5. **Pas de rafraîchissement temps réel** quand le watcher ré-indexe (re-fetch
   manuel requis).
6. **Pas de vues sauvegardées** ni de filtre par défaut par projet.
7. **Pas de visualisation des clusters Leiden** bien que `get_architecture` les
   retourne.
8. **3D peut ramer** sur GPU bas de gamme (DPR cap 1.5, multisampling off).

## 6. MCP tools existants (14)

`index_repository, search_graph, query_graph, trace_path, get_code_snippet,
get_graph_schema, get_architecture, search_code, list_projects,
delete_project, index_status, detect_changes, manage_adr, ingest_traces`

### Limitations clés des tools

- `manage_adr` : stocke les ADR comme un **blob project-level**, pas comme des
  records individuels liés à des symbols. Aucune cross-référence code ↔ ADR.
- `ingest_traces` : **stub** à `mcp.c:5290` — « Runtime edge creation from
  traces not yet implemented ». Le tool accepte les traces mais n'écrit pas
  d'edges.
- `search_graph` : cap 200 résultats par appel (pagination via `offset`+`limit`).
- `query_graph` : plafond 100k rows, pas d'`offset`.
- Pas de tool pour : notes humaines, blast radius symbol-level, undocumented
  hotspots, route flow, ADR-per-symbol, bugs, refactors, conventions, journal.

## 7. CLI existante

`(default)`, `cli <tool>`, `install`, `uninstall`, `update`, `config`, `hook-augment`, `--version`, `--help`, `--ui`, `--port`, `--profile`

Détection de **12 agents** : Claude Code, Codex CLI, Gemini CLI, Zed, OpenCode,
Antigravity, Aider, KiloCode, VS Code, Cursor, OpenClaw, Kiro. Pour chacun :
upsert config MCP + hooks spécifiques.

## 8. Indexers

- **tree-sitter** AST réel (pas regex) pour 158 langages
- **LSP custom** (type-aware) pour 11 langages : Python, TS/JS/JSX/TSX, PHP, C#,
  Go, C, C++, Java, Kotlin, Rust
- Pipeline 7 stages : Discover → Build structure → Bulk load sources → Extract
  definitions → Resolve edges → Pre-dump passes → Dump to SQLite
- Modes : `FULL`, `MODERATE`, `FAST`, `cross-repo-intelligence`
- Manifest-based package resolution pour 10+ écosystèmes (npm, go.mod, Cargo,
  pyproject, composer, pubspec, pom.xml, build.gradle, mix.exs, gemspec)

## 9. Limitations V1 (synthèse)

### 9.1 Performance

- Cap 2 000 nodes UI + stub `fetchDetail`
- HTTP single-threaded
- 200 résultats max par `search_graph`
- 100k rows max par `query_graph`
- Pas de streaming (single-blob JSON)
- Watcher polling (5-60 s) au lieu de inotify/FSEvents/kqueue
- Pas de refresh UI auto après re-index
- Windows TIME_WAIT accumulation sur polling UI

### 9.2 Mémoire humaine

**Totalement absente.** Grep `obsidian`, `human memory`, `notes integration` →
zéro match. Le mot « memory » dans le nom du projet ne désigne que la mémoire
**du code** (le graphe persisté). Pas de label humain, pas d'edge humain, pas
d'ingestion Markdown, pas de sync notes ↔ graphe.

### 9.3 Obsidian

**Totalement absent.** Pas de vault, pas de wiki-link parsing, pas de
frontmatter schema, pas de sync Markdown. L'artefact équipe
`.codebase-memory/graph.db.zst` est un dump SQLite binaire, pas du Markdown.

### 9.4 UI (par défaut = graphe complet)

Voir §5.

### 9.5 Stockage

- Un DB SQLite par projet, pas de sharding
- Pas de backend remote (Neo4j, DuckDB, etc.)
- Pas de multi-user / collaboration
- Artefact équipe via `.gitattributes merge=ours` (conflits non résolus)

### 9.6 Autres

- `ingest_traces` stub
- LSP : 147/158 langages sans type-aware resolution
- Pas de plugin system
- ADRs project-level seulement
- `auto_index_limit` default 50k fichiers
- `hook-augment` Claude-Code-specific en esprit

## 10. Ce qui est bon dans V1 (à conserver absolument)

| Atout | Raison |
|---|---|
| Moteur C pur avec tree-sitter | Performance, 158 langages, atomicité |
| SQLite WAL + FTS5 | Persistance robuste, full-text search |
| 14 MCP tools existants | Base solide à étendre |
| Cypher subset | Requêtes lisibles sans apprendre DSL |
| 11-signal semantic similarity | Plus riche que du pure embeddings |
| Team artifact `.db.zst` | Sharing simple via git |
| Single binary distribution | Install friction zéro |
| 91 tests C + 6 tests UI | Qualité prouvée |
| HTTP server 127.0.0.1-only | Sécurité local-first |
| Détection 12 agents | DX excellente |
| `cbm_userconfig_t` JSON | Extension simple (config user/projet) |
| Pipeline pass registry | Ajout de passes via function pointers |
| `TOOLS[]` MCP array | Ajout de tools via `strcmp` dispatch |

## 11. Ce qui doit être conservé

1. Le moteur C **inchangé** dans son cœur (foundation, store, pipeline, cypher,
   mcp existant). Trop de tests (5 604) et trop de langages (158) pour
   réécrire.
2. L'UI React/Three.js existante (on l'étendra, on ne la remplace pas).
3. La distribution single-binary via npm/pypi/homebrew.
4. Le protocole MCP existant (on garde les 14 tools, on en ajoute).
5. L'artefact `.db.zst` pour le partage équipe.
6. Le format SQLite pour le graphe code.

## 12. Ce qui doit être modifié

| Élément | Modification |
|---|---|
| `cbm_userconfig_t` | Ajouter clés `obsidian`, `human_memory`, `v2_*` |
| MCP `TOOLS[]` | Ajouter ~15 nouveaux tools V2 |
| UI `TabId` | Ajouter `notes`, `memory`, `decisions` tabs |
| UI `fetchDetail()` | Implémenter le vrai subgraph expansion (centré sur un nœud) |
| UI `GraphTab.tsx` | Default à un dashboard d'architecture, pas le graphe complet |
| `manage_adr` | Étendre pour per-symbol ADRs (ou créer un nouveau tool) |
| `ingest_traces` | Compléter le stub |
| `src/ui/http_server.c` | Ajouter routes `/api/human-notes`, `/api/obsidian/*`, `/api/hotspots` |
| `~/.cache/codebase-memory-mcp/_config.db` | Nouvelles clés KV |

## 13. Ce qui doit être ajouté (V2 net-new)

1. **Human memory layer** : nouveau DB SQLite (séparé du code graph) pour notes,
   ADRs, bugs, refactors, conventions, prompts, journal. Liens vers `cbm_node_id`.
2. **Obsidian vault** : génération, sync, import, export. Format Markdown +
   frontmatter YAML + wikilinks. Structure documentée dans
   `OBSIDIAN_INTEGRATION.md`.
3. **15 nouveaux MCP tools** orientés agent IA (lecture + écriture de mémoire
   humaine). Voir `V2_ARCHITECTURE.md`.
4. **Nouvelles vues UI** : Architecture Dashboard, Module Ego Graph, Route Flow,
   Blast Radius, Human Memory Overlay, Documentation Coverage, Risk Dashboard.
5. **Reports CLI** : `report hotspots`, `report undocumented`, `report risk`.
6. **Système de plugins** (optionnel, post-MVP) : C ABI pour extracteurs tiers.
7. **Schema registry** (optionnel) : validation des `properties_json` par label.
8. **Event bus** (optionnel) : pub/sub pour hooks de human-memory sur création
   de nœuds.

## 14. Ce qui doit être remplacé

- **Rien à remplacer totalement**. V2 est additif. Le moteur C reste.
- La seule chose qu'on peut « remplacer » conceptuellement, c'est
  l'**expérience par défaut** : passer de « ouvrir sur le graphe complet » à
  « ouvrir sur un dashboard d'architecture filtré ».

## 15. Risques techniques V2

| Risque | Mitigation |
|---|---|
| Coupler human-memory au code C casse la compilation | Garder human-memory en TypeScript sidecar, communique via MCP + SQLite RO |
| Perfs sur 15k+ nodes avec jointures code ↔ human | Index sur `cbm_node_id`, pagination, lazy loading |
| Écraser notes humaines pendant sync Obsidian | Sections `## HUMAN NOTES` inviolables, diff avant write, backup `.bak` |
| Conflits `.db.zst` équipe + vault `.md` | `.gitattributes merge=ours` pour `.db.zst`, vault en `.gitignore` par défaut (opt-in commit) |
| Migration schéma human DB | Système de migrations avec `schema_version` |
| Tokens/notes vers cloud | Privacy : `localOnly: true` par défaut, opt-in explicite pour télémétrie |
| Compatibilité ascendante configs | Userconfig charge silencieusement les clés inconnues (forward-compat) |
| Tests V2 | Suite TypeScript dédiée dans `v2/tests/`, ne pas casser les 5 604 tests C |

## 16. Décision d'architecture V2 (résumé)

V2 = **V1 + sidecar TypeScript** :

```
┌──────────────────────────────────────────────────────────────────┐
│  Codebase Memory V2 (process unique, distribué comme binaire C)  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────────────────────┐    ┌────────────────────────────┐ │
│   │  C Engine (V1 inchangé) │    │  TS Sidecar (V2 nouveau)   │ │
│   │  ─────────────────────  │    │  ───────────────────────── │ │
│   │  • tree-sitter 158 lang │    │  • Human Memory DB         │ │
│   │  • SQLite code graph    │◄───┤  • Obsidian vault sync     │ │
│   │  • 14 MCP tools (exist) │    │  • 15 new MCP tools        │ │
│   │  • Cypher engine        │    │  • Reports CLI             │ │
│   │  • HTTP UI server       │    │  • Plugin loader (post-MVP)│ │
│   │  • React/Three.js UI    │    │  • Schema registry         │ │
│   └────────────┬────────────┘    └────────────┬───────────────┘ │
│                │                                │                 │
│                └───────────┬────────────────────┘                 │
│                            │                                      │
│                            ▼                                      │
│              JSON-RPC over stdio (MCP)                            │
│              + SQLite RO access                                   │
│              + HTTP /api/* routes                                 │
└──────────────────────────────────────────────────────────────────┘
```

Pour le détail : voir `V2_ARCHITECTURE.md`.
