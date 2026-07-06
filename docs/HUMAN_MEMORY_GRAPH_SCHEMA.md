# Human Memory Graph Schema — Codebase Memory V2

> Schéma de données du graphe de mémoire humaine. Complément du code graph V1.
> Voir `V2_ARCHITECTURE.md` §4 pour la stratégie "deux DBs, jointures à la lecture".

## 1. Vue d'ensemble

Le human memory graph vit dans un SQLite DB séparé :
`~/.cache/codebase-memory-mcp/<project>.human.db`

```
┌─────────────────────────────────────────────────────────────┐
│  Code Graph V1 (inchangé)         <project>.db              │
│  ─────────────────────────────────────────────              │
│  nodes (Function, Method, Class, ...)                       │
│  edges (CALLS, IMPORTS, ...)                                 │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ cbm_node_id (FK logique)
                            │
┌─────────────────────────────────────────────────────────────┐
│  Human Memory Graph V2 (nouveau)  <project>.human.db        │
│  ─────────────────────────────────────────────              │
│  human_nodes (ADR, BugNote, RefactorPlan, ...)              │
│  human_edges (EXPLAINS, DECIDES, AFFECTS, ...)              │
│  human_metrics (cache documentation_coverage, risk_score)   │
│  schema_migrations                                          │
└─────────────────────────────────────────────────────────────┘
```

## 2. Types de nodes humains

### 2.1 Énumération `HumanNodeLabel`

```typescript
type HumanNodeLabel =
  | 'ArchitectureNote'   // Note d'architecture générale
  | 'ADR'                // Architecture Decision Record
  | 'BugNote'            // Bug connu documenté
  | 'RefactorPlan'       // Plan de refactor
  | 'LegacyNote'         // Zone legacy identifiée
  | 'Convention'         // Convention projet (coding ou architecture)
  | 'Prompt'             // Prompt utile pour agents IA
  | 'JournalEntry'       // Entrée de journal (1 par jour)
  | 'ModuleNote'         // Note attachée à un module
  | 'RouteNote'          // Note attachée à une route HTTP
  | 'RiskNote';          // Risque identifié
```

### 2.2 Sémantique de chaque type

| Label | Quand l'utiliser | Exemple |
|---|---|---|
| `ArchitectureNote` | Note transverse sur l'architecture (pas liée à un module spécifique) | "Le système suit une architecture hexagonale" |
| `ADR` | Décision d'architecture importante, numérotée | "ADR-003: Utiliser JWT pour les sessions" |
| `BugNote` | Bug connu mais pas encore fixé, documenté pour la postérité | "Le refresh token expire si 2 sessions" |
| `RefactorPlan` | Plan de refactor identifié, avec scope et priorité | "Extraire SessionProvider de auth" |
| `LegacyNote` | Zone identifiée comme legacy, à ne pas toucher | "Le module `legacy-billing` ne doit plus être modifié" |
| `Convention` | Convention de code ou d'architecture | "Toutes les routes doivent être préfixées par /api/v2" |
| `Prompt` | Prompt IA utile pour le projet | "Prompt pour expliquer un module à un nouvel agent" |
| `JournalEntry` | Journal d'activité (1 entrée par jour) | "2026-07-04 : Refactor de auth, ADR-003 créée" |
| `ModuleNote` | Note attachée à un module spécifique | "Le module auth gère JWT + 2FA" |
| `RouteNote` | Note attachée à une route HTTP | "POST /api/login supporte SSO Google" |
| `RiskNote` | Risque identifié sur un symbol/module | "SessionProvider est trop couplée, fragile" |

## 3. Types d'edges humains

### 3.1 Énumération `HumanEdgeType`

```typescript
type HumanEdgeType =
  | 'EXPLAINS'      // La note explique le code node
  | 'DECIDES'       // L'ADR décide quelque chose qui affecte le code node
  | 'AFFECTS'       // Le bug affecte le code node
  | 'TOUCHES'       // Le refactor touche le code node
  | 'DOCUMENTS'     // La note documente le code node
  | 'DEPRECATES'    // L'ADR/note deprecate le code node
  | 'REPLACES'      // Le refactor remplace le code node
  | 'RISKS'         // La note de risque pointe le code node fragile
  | 'MENTIONS'      // La note mentionne le code node (générique)
  | 'JUSTIFIES'     // L'ADR justifie le choix de code
  | 'OWNS'          // La convention/propriétaire possède le module
  | 'TODO_FOR';     // Bug/refactor TODO pour le code node
```

### 3.2 Sémantique

| Edge | Source (human) | Target (code ou human) | Exemple |
|---|---|---|---|
| `EXPLAINS` | ArchitectureNote, ModuleNote, RouteNote | Code node | "Note auth" EXPLAINS Module:auth |
| `DECIDES` | ADR | Code node (Module, Route, Interface) | "ADR-003" DECIDES Module:auth |
| `AFFECTS` | BugNote | Code node (Route, Module, Function) | "Bug-login" AFFECTS Route:/api/login |
| `TOUCHES` | RefactorPlan | Code node (Module, File, Function) | "Refactor-payment" TOUCHES Module:payment |
| `DOCUMENTS` | ModuleNote, RouteNote | Code node | "Note auth" DOCUMENTS Module:auth |
| `DEPRECATES` | ADR, LegacyNote | Code node | "ADR-005" DEPRECATES Module:legacy-billing |
| `REPLACES` | RefactorPlan | Code node | "Refactor-payment" REPLACES Function:oldCharge |
| `RISKS` | RiskNote | Code node (Interface, Function) | "Risk-auth" RISKS Interface:SessionProvider |
| `MENTIONS` | Toute note | Code node ou human node | "Journal 2026-07-04" MENTIONS ADR-003 |
| `JUSTIFIES` | ADR | Code node | "ADR-003" JUSTIFIES Function:validateToken |
| `OWNS` | Convention | Module | "Convention-auth" OWNS Module:auth |
| `TODO_FOR` | BugNote, RefactorPlan | Code node | "Refactor-auth" TODO_FOR Function:login |

### 3.3 Edges human ↔ human

Les edges peuvent aussi lier deux human nodes. Exemples :

- `ADR-003` `MENTIONS` `BugNote-login-session`
- `RefactorPlan-extract-session` `REPLACES` `ADR-002` (une ADR remplacée)
- `JournalEntry-2026-07-04` `MENTIONS` `ADR-003`

Dans ce cas, `target_kind = 'human'` au lieu de `'code'`.

## 4. Schéma SQL complet

### 4.1 Table `human_nodes`

```sql
CREATE TABLE human_nodes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project         TEXT NOT NULL,
    label           TEXT NOT NULL CHECK(label IN (
        'ArchitectureNote', 'ADR', 'BugNote', 'RefactorPlan',
        'LegacyNote', 'Convention', 'Prompt', 'JournalEntry',
        'ModuleNote', 'RouteNote', 'RiskNote'
    )),
    title           TEXT NOT NULL,
    slug            TEXT NOT NULL,             -- pour wikilinks [[<slug>]]
    body_markdown   TEXT NOT NULL DEFAULT '',  -- contenu éditorial (sans frontmatter)
    frontmatter_json TEXT NOT NULL DEFAULT '{}', -- JSON sérialisé
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK(status IN ('draft', 'active', 'reviewed', 'deprecated')),
    source          TEXT NOT NULL DEFAULT 'human'
                    CHECK(source IN ('human', 'generated', 'mixed')),
    obsidian_path   TEXT,                      -- chemin relatif dans le vault
    cbm_node_ids    TEXT NOT NULL DEFAULT '[]', -- JSON array of int
    tags            TEXT NOT NULL DEFAULT '[]', -- JSON array of string
    provenance      TEXT NOT NULL DEFAULT 'human',
    confidence      REAL NOT NULL DEFAULT 1.0
                    CHECK(confidence >= 0.0 AND confidence <= 1.0),
    source_file     TEXT,                      -- si importé depuis un fichier
    author          TEXT,                      -- optionnel (Git author, username)
    created_at      TEXT NOT NULL,             -- ISO 8601
    updated_at      TEXT NOT NULL,
    last_synced_at  TEXT,                      -- dernier sync Obsidian
    UNIQUE(project, slug)
);

-- R20 (migration V2): replaced the original single-column indexes with two
-- composite indexes that match the actual query patterns. The previous
-- idx_human_nodes_project / _label / _status were redundant (the composites
-- cover their leading column) and idx_human_nodes_cbm_node_ids (a JSON-text
-- index) was useless — JSON_EACH cannot use a text index on the JSON column.
CREATE INDEX idx_human_nodes_project_label  ON human_nodes(project, label);
CREATE INDEX idx_human_nodes_project_status ON human_nodes(project, status);
CREATE INDEX idx_human_nodes_obsidian_path  ON human_nodes(obsidian_path);
CREATE INDEX idx_human_nodes_updated_at     ON human_nodes(updated_at);
```

### 4.6 Table `human_node_cbm_links` (R21 / migration V3)

Junction table that replaces the JSON_EACH-on-`cbm_node_ids` query pattern.
The original schema stored `cbm_node_ids` as a JSON array column on `human_nodes`;
queries like "find all notes linked to code node X" required `JSON_EACH(cbm_node_ids)`
which is a full-table scan and cannot use any index.

```sql
CREATE TABLE human_node_cbm_links (
    human_node_id   INTEGER NOT NULL,
    cbm_node_id     INTEGER NOT NULL,
    project         TEXT NOT NULL,
    PRIMARY KEY(human_node_id, cbm_node_id),
    FOREIGN KEY(human_node_id) REFERENCES human_nodes(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX idx_cbm_links_cbm_id ON human_node_cbm_links(cbm_node_id);
```

`WITHOUT ROWID` makes the table a clustered B-tree on the primary key, so:
- lookup "all cbm ids for note N" → PK seek + range scan (no JSON parse)
- lookup "all notes linked to cbm node X" → covering index `idx_cbm_links_cbm_id`

The `cbm_node_ids` JSON column is still present on `human_nodes` for backward
compatibility and is kept in sync by `HumanMemoryStore.syncCbmLinks` (called
from `createNode`/`updateNode`). New code should query the junction table
(`getBulkNotesByCbmNodeIds`, `syncCbmLinks`) — never `JSON_EACH`.

### 4.7 FTS5 index `human_nodes_fts` (R41 / migration V4)

Full-text search index over `human_nodes`' searchable columns. Replaces the
5× `LIKE %q%` substring scan in `search_code_and_memory` with a single
`MATCH` query against the inverted index.

```sql
CREATE VIRTUAL TABLE human_nodes_fts USING fts5(
  title, body_markdown, tags, frontmatter_json, author,
  content='human_nodes',
  content_rowid='id',
  tokenize='porter unicode61'
);
```

External-content pattern: the FTS5 table stores only the inverted index, not
the row data. Three triggers keep it in sync on INSERT/UPDATE/DELETE:
`human_nodes_fts_ai`, `human_nodes_fts_ad`, `human_nodes_fts_au`.

Tokenizer: `porter unicode61` — porter stemming for English + unicode61 for
accented chars (French titles like "décision" work correctly).

Query pattern (in `HumanMemoryStore.searchHumanNodes`):
```sql
SELECT n.* FROM human_nodes n
JOIN human_nodes_fts f ON f.rowid = n.id
WHERE n.project = ? AND n.status != 'deprecated' AND human_nodes_fts MATCH ?
ORDER BY rank   -- BM25 scoring
LIMIT ?
```

The method falls back to the old 5× `LIKE %q%` scan if the FTS5 table is
missing (pre-V4 DB) or if the query syntax trips FTS5's parser.

### 4.2 Table `human_edges`

```sql
CREATE TABLE human_edges (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    project                 TEXT NOT NULL,
    source_human_node_id    INTEGER NOT NULL,
    target_kind             TEXT NOT NULL CHECK(target_kind IN ('code', 'human')),
    target_cbm_node_id      INTEGER,           -- si target_kind = 'code'
    target_human_node_id    INTEGER,           -- si target_kind = 'human'
    type                    TEXT NOT NULL CHECK(type IN (
        'EXPLAINS', 'DECIDES', 'AFFECTS', 'TOUCHES',
        'DOCUMENTS', 'DEPRECATES', 'REPLACES', 'RISKS',
        'MENTIONS', 'JUSTIFIES', 'OWNS', 'TODO_FOR'
    )),
    properties_json         TEXT NOT NULL DEFAULT '{}',
    provenance              TEXT NOT NULL DEFAULT 'human',
    confidence              REAL NOT NULL DEFAULT 1.0,
    source_file             TEXT,
    created_at              TEXT NOT NULL,
    FOREIGN KEY(source_human_node_id) REFERENCES human_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY(target_human_node_id) REFERENCES human_nodes(id) ON DELETE CASCADE,
    CHECK(
        (target_kind = 'code' AND target_cbm_node_id IS NOT NULL AND target_human_node_id IS NULL)
        OR
        (target_kind = 'human' AND target_human_node_id IS NOT NULL AND target_cbm_node_id IS NULL)
    )
);

CREATE INDEX idx_human_edges_project ON human_edges(project);
CREATE INDEX idx_human_edges_source ON human_edges(source_human_node_id);
CREATE INDEX idx_human_edges_target_cbm ON human_edges(target_cbm_node_id);
CREATE INDEX idx_human_edges_target_human ON human_edges(target_human_node_id);
CREATE INDEX idx_human_edges_type ON human_edges(type);
```

### 4.3 Table `human_metrics` (cache)

```sql
CREATE TABLE human_metrics (
    project             TEXT NOT NULL,
    cbm_node_id         INTEGER NOT NULL,
    documentation_coverage REAL NOT NULL,   -- 0.0 à 1.0
    risk_score          REAL NOT NULL,      -- 0.0 à 1.0
    notes_count         INTEGER NOT NULL DEFAULT 0,
    adrs_count          INTEGER NOT NULL DEFAULT 0,
    bugs_count          INTEGER NOT NULL DEFAULT 0,
    refactors_count     INTEGER NOT NULL DEFAULT 0,
    computed_at         TEXT NOT NULL,
    PRIMARY KEY(project, cbm_node_id)
);

CREATE INDEX idx_human_metrics_project ON human_metrics(project);
CREATE INDEX idx_human_metrics_doc_coverage ON human_metrics(project, documentation_coverage);
CREATE INDEX idx_human_metrics_risk ON human_metrics(project, risk_score);
```

### 4.4 Table `schema_migrations`

```sql
CREATE TABLE schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TEXT NOT NULL
);
```

### 4.5 Table `sync_state` (audit sync Obsidian)

```sql
CREATE TABLE sync_state (
    project             TEXT NOT NULL,
    obsidian_path       TEXT NOT NULL,
    last_synced_hash    TEXT NOT NULL,        -- hash du contenu au dernier sync
    last_synced_at      TEXT NOT NULL,
    last_direction      TEXT NOT NULL CHECK(last_direction IN ('export', 'import', 'both')),
    PRIMARY KEY(project, obsidian_path)
);
```

## 5. Migration initiale (version 1)

```sql
-- Migration 001: initial_schema
-- Toutes les tables ci-dessus sont créées ici.
INSERT INTO schema_migrations (version, name, applied_at)
VALUES (1, 'initial_schema', datetime('now'));
```

## 6. Requêtes typiques

### 6.1 Toutes les notes humaines liées à un code node

```sql
SELECT hn.*
FROM human_nodes hn
JOIN human_edges he ON he.source_human_node_id = hn.id
WHERE he.target_kind = 'code'
  AND he.target_cbm_node_id = ?
  AND hn.project = ?;
```

### 6.2 Tous les ADRs qui décident d'un module

```sql
SELECT hn.*
FROM human_nodes hn
JOIN human_edges he ON he.source_human_node_id = hn.id
WHERE he.target_kind = 'code'
  AND he.target_cbm_node_id = ?
  AND he.type = 'DECIDES'
  AND hn.label = 'ADR'
  AND hn.project = ?;
```

### 6.3 Modules critiques sans note humaine (undocumented hotspots)

```sql
-- Côté code graph (V1 SQLite, lecture RO)
-- SELECT id, name, qualified_name, file_path FROM nodes
-- WHERE project = ? AND label = 'Module'

-- Côté human graph : modules qui n'ont AUCUNE note humaine
-- (la jointure se fait en TypeScript, pas en SQL cross-DB)
SELECT cbm_node_id
FROM human_metrics
WHERE project = ?
  AND notes_count = 0;
```

### 6.4 Risk score d'un code node

```sql
SELECT risk_score, documentation_coverage
FROM human_metrics
WHERE project = ? AND cbm_node_id = ?;
```

### 6.5 Toutes les ADRs actives

```sql
SELECT id, title, slug, body_markdown, frontmatter_json, tags, updated_at
FROM human_nodes
WHERE project = ? AND label = 'ADR' AND status = 'active'
ORDER BY updated_at DESC;
```

### 6.6 Bugs affectant un module

```sql
SELECT hn.id, hn.title, hn.body_markdown, he.type
FROM human_nodes hn
JOIN human_edges he ON he.source_human_node_id = hn.id
WHERE hn.label = 'BugNote'
  AND hn.status = 'active'
  AND he.target_kind = 'code'
  AND he.target_cbm_node_id = ?
  AND he.type IN ('AFFECTS', 'TODO_FOR')
  AND hn.project = ?;
```

## 7. Exemples complets

### 7.1 ADR-003: Use JWT for sessions

```yaml
# human_nodes row
id: 2
project: my-app
label: ADR
title: "ADR-003: Use JWT for sessions"
slug: adr-003-use-jwt-for-sessions
body_markdown: |
  ## Contexte

  Le système utilisait des cookies de session côté serveur. Cela posait
  problème pour la scalabilité horizontale (sticky sessions nécessaires).

  ## Décision

  Migrer vers JWT signés côté serveur, stockés côté client (HttpOnly cookie).

  ## Conséquences

  - Plus besoin de sticky sessions
  - Rotation des clés à prévoir
  - Logout immédiat impossible (token valide jusqu'à expiration)
frontmatter_json: |
  {
    "type": "adr",
    "status": "active",
    "source": "human",
    "cbm_node_ids": [1234, 1235],
    "tags": ["auth", "security", "session"],
    "related_modules": ["auth"],
    "related_adrs": ["ADR-001", "ADR-002"]
  }
status: active
source: human
obsidian_path: ADR/ADR-003-use-jwt-for-sessions.md
cbm_node_ids: '[1234, 1235]'  -- Module:auth, Function:validateToken
tags: '["auth", "security", "session"]'
provenance: human
confidence: 1.0
created_at: 2026-06-15T10:30:00Z
updated_at: 2026-07-04T09:15:00Z
```

```yaml
# human_edges rows
- source_human_node_id: 2
  target_kind: code
  target_cbm_node_id: 1234  -- Module:auth
  type: DECIDES
  properties_json: '{"reason": "JWT chosen over cookies"}'

- source_human_node_id: 2
  target_kind: code
  target_cbm_node_id: 1235  -- Function:validateToken
  type: JUSTIFIES
  properties_json: '{"reason": "validateToken implements JWT verification"}'
```

### 7.2 BugNote: Login session conflict

```yaml
# human_nodes row
id: 5
project: my-app
label: BugNote
title: "Bug: Login session conflict with 2 concurrent sessions"
slug: bug-login-session-conflict
body_markdown: |
  ## Symptôme

  Quand un user a 2 sessions (2 onglets), le refresh token expire prématurément.

  ## Reproduction

  1. Login dans onglet A
  2. Login dans onglet B
  3. Attendre > refresh window
  4. L'onglet A est déconnecté

  ## Cause suspectée

  Le refresh token est écrasé à chaque login. Voir `Function:login` ligne 67.

  ## Status: OPEN
frontmatter_json: |
  {
    "type": "bug",
    "status": "active",
    "source": "human",
    "cbm_node_ids": [1240, 1235],
    "tags": ["bug", "auth", "session"],
    "related_modules": ["auth"],
    "related_routes": ["POST-/api/login"]
  }
status: active
source: human
obsidian_path: Bugs/bug-login-session-conflict.md
cbm_node_ids: '[1240, 1235]'  -- Route:/api/login, Function:login
tags: '["bug", "auth", "session"]'
provenance: human
```

```yaml
# human_edges rows
- source_human_node_id: 5
  target_kind: code
  target_cbm_node_id: 1240  -- Route:/api/login
  type: AFFECTS

- source_human_node_id: 5
  target_kind: code
  target_cbm_node_id: 1235  -- Function:login
  type: TODO_FOR
  properties_json: '{"todo": "Fix refresh token overwrite at line 67"}'
```

### 7.3 RefactorPlan: Extract SessionProvider

```yaml
# human_nodes row
id: 7
project: my-app
label: RefactorPlan
title: "Refactor: Extract SessionProvider from auth module"
slug: refactor-extract-session-provider
body_markdown: |
  ## Motivation

  `SessionProvider` (src/auth/session.ts) est trop couplée à `auth` :
  - Importe `validateToken` (logique métier)
  - Importe `UserRepository` (DB)
  - 47 dépendances directes

  ## Scope

  - Extraire `SessionProvider` vers `src/session/provider.ts`
  - Créer interface `ISessionStore`
  - Adapter `auth` pour dépendre de l'interface

  ## Priorité: HIGH

  ## Effort estimé: 3 jours

  ## Risques

  - Pas de tests sur `SessionProvider` actuellement
  - 47 callers à adapter
frontmatter_json: |
  {
    "type": "refactor",
    "status": "active",
    "source": "human",
    "cbm_node_ids": [1500, 1234],
    "tags": ["refactor", "auth", "session", "high-priority"],
    "related_modules": ["auth", "session"],
    "related_adrs": ["ADR-003"]
  }
status: active
source: human
obsidian_path: Refactor/refactor-extract-session-provider.md
cbm_node_ids: '[1500, 1234]'  -- Class:SessionProvider, Module:auth
```

## 8. Politique de validation

### 8.1 Contraintes CHECK

- `human_nodes.label` doit être dans l'énumération
- `human_nodes.status` doit être dans l'énumération
- `human_nodes.source` doit être dans l'énumération
- `human_nodes.confidence` doit être entre 0 et 1
- `human_edges.type` doit être dans l'énumération
- `human_edges.target_kind` doit être `'code'` ou `'human'`
- Si `target_kind = 'code'` → `target_cbm_node_id` requis, `target_human_node_id` NULL
- Si `target_kind = 'human'` → inverse

### 8.2 Unicité

- `human_nodes(project, slug)` UNIQUE — pas de doublon de slug par projet
- `human_edges(source_human_node_id, target_kind, target_cbm_node_id, target_human_node_id, type)` UNIQUE
  (pas de doublon d'edge identique)

### 8.3 Cascades

- Suppression d'une `human_node` → CASCADE sur `human_edges` où elle est source
- Suppression d'une `human_node` target → SET NULL sur `human_edges.target_human_node_id`
  (ou CASCADE — configurable)

## 9. Performance

### 9.1 Index stratégiques

- `human_nodes(project, slug)` UNIQUE → résolution wikilinks rapide
- `human_edges(target_cbm_node_id)` → "toutes les notes pour ce code node" rapide
- `human_metrics(project, cbm_node_id)` PRIMARY KEY → cache O(1)

### 9.2 Pagination

Toutes les requêtes V2 utilisent `LIMIT ? OFFSET ?`. Pas de SELECT * sans
limit.

### 9.3 Cache `human_metrics`

Recalculé à chaque write sur `human_nodes` ou `human_edges`. Pour les gros
projets (15k+ code nodes), le calcul complet est différé (background job) et
on sert la version précédente du cache.

## 10. Conventions de nommage

### 10.1 Slugs

- Format : `<label-prefix>-<kebab-case-title>`
- Exemples :
  - `adr-003-use-jwt-for-sessions`
  - `bug-login-session-conflict`
  - `refactor-extract-session-provider`
  - `module-note-auth`
  - `route-note-post-api-login`
  - `risk-auth-coupling`
  - `journal-2026-07-04`

### 10.2 Obsidian paths

| Label | Path |
|---|---|
| ArchitectureNote | `Architecture/<slug>.md` |
| ADR | `ADR/<slug>.md` |
| BugNote | `Bugs/<slug>.md` |
| RefactorPlan | `Refactor/<slug>.md` |
| LegacyNote | `Legacy/<slug>.md` |
| Convention | `Conventions/<slug>.md` |
| Prompt | `Prompts/<slug>.md` |
| JournalEntry | `Journal/<YYYY-MM-DD>.md` |
| ModuleNote | `Modules/<module-name>.md` |
| RouteNote | `Routes/<METHOD>-<path-slug>.md` |
| RiskNote | `Architecture/risk-<slug>.md` |
