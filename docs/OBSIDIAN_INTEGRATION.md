# Obsidian Integration — Codebase Memory V2

> Comment V2 intègre Obsidian sans dépendre de son code source.
> Le vault est un dossier Markdown standard, lisible par Obsidian, VS Code,
> ou n'importe quel éditeur de texte.

## 1. Philosophie

### 1.1 Ce qu'on fait

- Utiliser Obsidian comme **vault Markdown** standard
- S'appuyer sur des conventions ouvertes : Markdown, YAML frontmatter, `[[wikilinks]]`, tags
- Permettre la lecture/édition humaine des notes
- Synchroniser en arrière-plan

### 1.2 Ce qu'on ne fait pas

- ❌ Copier le code source d'Obsidian (qui n'est d'ailleurs pas open-source)
- ❌ Réimplémenter Obsidian
- ❌ Dépendre d'Obsidian pour fonctionner (le vault est juste du Markdown)
- ❌ Prétendre utiliser le repo `obsidianmd/obsidian-releases` (qui ne contient
  pas le code source de l'app)
- ❌ Créer un plugin Obsidian dans le MVP (optionnel en post-V1)

### 1.3 Compatibilité éditeurs

Le vault généré est compatible avec :
- **Obsidian** (graphe de backlinks, wikilinks, tags)
- **VS Code** (avec extension Foam ou Markdown Notes)
- **Logseq** (mode Markdown)
- **Neovim/Vim** (avec plugins Markdown)
- N'importe quel éditeur de texte brut

## 2. Structure du vault

Le vault est créé à `<repo>/.codebase-memory-vault/`. Configurable via
`.codebase-memory.json` → `v2.obsidian.vaultPath`.

```
.codebase-memory-vault/
├── 00_Index.md                    ← page d'accueil du vault
├── Architecture/
│   ├── overview.md                ← vue d'ensemble (auto-générée)
│   ├── modules.md                 ← liste des modules critiques
│   ├── routes.md                  ← liste des routes
│   ├── data-flow.md               ← flux de données principaux
│   ├── risk-map.md                ← zones à risque
│   └── hotspots.md                ← hotspots de complexité
├── ADR/
│   ├── ADR-000-template.md        ← template à copier
│   ├── ADR-001-use-jwt-sessions.md
│   └── ADR-002-extract-session-provider.md
├── Modules/
│   ├── auth.md
│   ├── payment.md
│   └── user.md
├── Routes/
│   ├── POST-api-login.md
│   ├── GET-api-users.md
│   └── POST-api-payment.md
├── Refactor/
│   ├── refactor-plan.md           ← plan global
│   ├── dead-code.md               ← candidats dead code
│   ├── high-coupling.md           ← modules trop connectés
│   └── blast-radius-<symbol>.md   ← analyses d'impact
├── Bugs/
│   ├── known-bugs.md              ← liste globale
│   └── bug-login-session.md
├── Legacy/
│   └── legacy-zones.md
├── Conventions/
│   ├── coding-conventions.md
│   └── architecture-conventions.md
├── Prompts/
│   ├── codebase-memory-prompts.md
│   └── agent-workflows.md
├── Journal/
│   └── 2026-07-04.md              ← une note par jour
└── .obsidian/                     ← créé par Obsidian au premier ouverture
    ├── app.json
    ├── appearance.json
    └── core-plugins.json
```

## 3. Format d'une note

Chaque note suit le même template :

```markdown
---
type: module | route | adr | bug | refactor | architecture | legacy | convention | prompt | journal
source: codebase-memory | human | mixed
status: generated | reviewed | active | deprecated
cbm_node_id: 1234
cbm_node_type: Module
cbm_project: my-app
related_modules: [auth, user]
related_routes: [POST-/api/login]
related_files: [src/auth/index.ts, src/auth/login.ts]
related_symbols: [Function:login, Class:SessionProvider]
related_adrs: [ADR-001]
related_bugs: [bug-login-session]
last_generated: 2026-07-04
last_synced: 2026-07-04T09:30:00Z
tags:
  - module
  - auth
  - critical
---

# Module: auth

## AUTO-GENERATED

> ⚠️ Cette section est contrôlée par Codebase Memory V2 et peut être régénérée.
> Ne pas éditer — vos modifications seraient perdues au prochain sync.

### Vue d'ensemble

- **Chemin** : `src/auth/index.ts`
- **Lignes de code** : 450
- **Complexité moyenne** : 8.2
- **Degré** : 47 (module critique)
- **Documentation coverage** : 65 %

### Functions (12)

| Name | Lines | Complexity | Exported |
|---|---|---|---|
| `login` | 45-89 | 12 | ✅ |
| `logout` | 90-110 | 4 | ✅ |
| `validateToken` | 112-140 | 6 | ✅ |
| ... | ... | ... | ... |

### Dépendances (15)

- `IMPORTS` ← `src/utils/logger.ts`
- `CALLS` → `Function:hashPassword` (in `src/auth/crypto.ts`)
- `HTTP_CALLS` → `POST https://api.example.com/sso`
- ...

### Risk score

- Coupling : 0.72 (high)
- Complexity : 0.45 (medium)
- Documentation : 0.35 (low) ← ⚠️ sous-documenté

---

## HUMAN NOTES

> ✏️ Cette section appartient à l'utilisateur. Elle ne sera **jamais** écrasée
> par Codebase Memory V2.

### Décisions

- 2024-03-15 : On a choisi JWT plutôt que cookies (voir ADR-001)
- 2024-04-02 : `SessionProvider` est trop couplée, plan de refactor en cours

### Bugs connus

- Le token refresh ne marche pas si le user a 2 sessions (voir [[bug-login-session]])

### À faire

- [ ] Extraire `SessionProvider` (voir [[refactor-plan]])
- [ ] Documenter la politique d'expiration des tokens
```

## 4. Règle critique : préservation des HUMAN NOTES

### 4.1 Principe

La section `## HUMAN NOTES` (et tout ce qui suit jusqu'à la fin du fichier)
appartient à l'utilisateur. **Codebase Memory V2 ne l'écrase jamais.**

### 4.2 Implémentation

Lors d'un sync `DB → vault` :

```typescript
function syncNoteToVault(humanNode, existingContent) {
  if (!existingContent) {
    // Première création : écrire le template complet
    return renderFullNote(humanNode);
  }

  const parsed = parseNoteSections(existingContent);
  // parsed = { frontmatter, autoGenerated, humanNotes }

  // Régénérer uniquement AUTO-GENERATED
  const newAutoGenerated = renderAutoGenerated(humanNode);

  // Préserver frontmatter (merge : DB wins pour les clés techniques,
  // human wins pour les clés éditoriales)
  const mergedFrontmatter = mergeFrontmatter(
    parsed.frontmatter,
    renderFrontmatter(humanNode)
  );

  // Préserver HUMAN NOTES à l'identique
  const newContent = [
    `---\n${mergedFrontmatter}\n---\n\n`,
    `# ${humanNode.title}\n\n`,
    `## AUTO-GENERATED\n\n${newAutoGenerated}\n\n`,
    `---\n\n`,
    `## HUMAN NOTES\n\n${parsed.humanNotes}\n`
  ].join('');

  // Backup avant write si diff
  if (newContent !== existingContent) {
    fs.writeFileSync(`${path}.bak.${Date.now()}`, existingContent);
    fs.writeFileSync(path, newContent);
  }
}
```

### 4.3 Tests de non-régression

Le test `tests/regression/human-notes-preserved.test.ts` vérifie :

1. Sync initial crée la note avec `## HUMAN NOTES` vide
2. Modification manuelle de `## HUMAN NOTES`
3. Re-sync ne modifie pas `## HUMAN NOTES`
4. Re-sync met à jour `## AUTO-GENERATED`
5. Backup `.bak` créé

### 4.4 Diff avant modification

Avant tout write, V2 calcule un diff et :

- Si seule `## AUTO-GENERATED` change → write direct (avec backup)
- Si `## HUMAN NOTES` change aussi → alerte utilisateur, confirmation requise
- Si la note n'existe pas → création

## 5. Wikilinks

### 5.1 Format

V2 utilise deux formats de wikilinks :

| Format | Cible | Exemple |
|---|---|---|
| `[[<cbm_node_id>]]` | Code node V1 | `[[1234]]` |
| `[[<human_node_id>]]` | Human node V2 | `[[adr-001-use-jwt-sessions]]` (slug) |
| `[[<slug>\|alias]]` | Avec alias | `[[adr-001\|ADR JWT]]` |
| `[[<path>]]` | Note par chemin | `[[Modules/auth.md]]` |

### 5.2 Résolution

À l'import vault → DB :

1. Parser tous les `[[...]]` avec regex `\[\[([^\]|]+)(?:\|([^\]]+))?\]\]`
2. Pour chaque lien :
   - Si c'est un entier → code node (cherche dans code graph)
   - Si c'est un slug → human node (cherche dans `human_nodes.slug`)
   - Si c'est un path → résoudre le path vers un `human_node`
3. Créer les `human_edges` correspondants :
   - Lien vers code node → `MENTIONS` (par défaut)
   - Lien vers ADR → `DECIDES` si dans section "Décisions"
   - Lien vers Bug → `AFFECTS` si dans section "Bugs connus"

### 5.3 Frontmatter pour résolution inverse

Chaque note a dans son frontmatter :

```yaml
cbm_node_id: 1234         # si la note est liée à un code node
cbm_node_type: Module
related_modules: [auth, user]
related_routes: [POST-/api/login]
related_adrs: [ADR-001]
```

Ces champs sont **auto-générés** (mis à jour par V2 à chaque sync) et permettent
à Obsidian de faire des backlinks même sans parser les wikilinks inline.

## 6. Tags

### 6.1 Tags Obsidian (inline)

```markdown
# Module: auth

Ce module gère l'authentification. #module #auth #critical
```

### 6.2 Tags frontmatter

```yaml
tags:
  - module
  - auth
  - critical
```

### 6.3 Convention de tags V2

| Tag | Signification |
|---|---|
| `#type/<label>` | Type de node : `#type/adr`, `#type/bug`, `#type/refactor` |
| `#status/<status>` | Statut : `#status/active`, `#status/deprecated` |
| `#module/<name>` | Module lié : `#module/auth` |
| `#route/<method>-<path>` | Route liée : `#route/POST-/api/login` |
| `#risk/<level>` | Niveau de risque : `#risk/high` |
| `#legacy` | Zone legacy |
| `#undocumented` | Sans note humaine |
| `#hotspot` | Hotspot de complexité |

## 7. Commandes CLI Obsidian

### 7.1 `cbm-v2 obsidian init`

```bash
cbm-v2 obsidian init [--vault .codebase-memory-vault]
```

- Crée la structure de dossiers
- Crée `00_Index.md` avec un sommaire
- Crée `ADR/ADR-000-template.md`
- Ajoute `.codebase-memory-vault/` au `.gitignore` du repo (si pas déjà exclu)
- Crée `.codebase-memory.json` si absent, avec `v2.obsidian.enabled = true`

### 7.2 `cbm-v2 obsidian sync`

```bash
cbm-v2 obsidian sync [--project my-app] [--dry-run] [--direction both|export|import]
```

Sync双向 :

1. **Export** : DB → vault (avec préservation HUMAN NOTES)
2. **Import** : vault → DB (avec merge par `obsidian_path`)

Flags :
- `--dry-run` : preview les changements sans write
- `--direction export` : seulement DB → vault
- `--direction import` : seulement vault → DB
- `--direction both` (défaut) : double sens

### 7.3 `cbm-v2 obsidian export`

```bash
cbm-v2 obsidian export [--project my-app] [--force]
```

One-shot : DB → vault. Crée toutes les notes manquantes. Si une note existe
déjà, préserve HUMAN NOTES (comme sync).

### 7.4 `cbm-v2 obsidian import`

```bash
cbm-v2 obsidian import [--project my-app] [--dry-run]
```

One-shot : vault → DB. Parse tous les `.md`, upsert dans `human_nodes` et
`human_edges`. Détection des notes orphelines (sans `cbm_node_id`).

### 7.5 `cbm-v2 obsidian report`

```bash
cbm-v2 obsidian report [--project my-app] [--format md|json]
```

Génère un rapport de l'état du vault :

- Nombre de notes par type
- Notes sans `cbm_node_id` (orphelines)
- Notes avec HUMAN NOTES vides
- Notes avec HUMAN NOTES modifiées depuis dernier sync
- Conflits potentiels

### 7.6 `cbm-v2 obsidian create-adr`

```bash
cbm-v2 obsidian create-adr --title "ADR-003: Use Redis for sessions" \
  --module auth --status active
```

Crée :

1. Un `human_node` avec `label = ADR`
2. Un fichier `ADR/ADR-003-use-redis-for-sessions.md` avec template
3. Un `human_edge` `DECIDES` vers le module `auth`

### 7.7 `cbm-v2 obsidian create-module-note`

```bash
cbm-v2 obsidian create-module-note --module auth
```

Crée une note `Modules/auth.md` pré-remplie avec AUTO-GENERATED et HUMAN NOTES
vide.

### 7.8 `cbm-v2 obsidian create-route-note`

```bash
cbm-v2 obsidian create-route-note --route "POST /api/login"
```

Idem pour une route HTTP.

## 8. Génération automatique des notes

### 8.1 Politique

V2 peut **auto-générer** des notes pour :

| Type | Condition | Config |
|---|---|---|
| Module note | `degree >= minDegreeForModuleNote` (default 20) | `v2.obsidian.autoGenerateModuleNotes` |
| Route note | Toutes les routes HTTP | `v2.obsidian.autoGenerateRouteNotes` |
| Architecture overview | Toujours (régénérée à chaque sync) | — |
| Hotspots report | Toujours | — |
| Risk map | Toujours | — |

### 8.2 Notes jamais auto-générées

- ADR (toujours humaines)
- BugNote (toujours humaines)
- RefactorPlan (toujours humaines)
- Convention (toujours humaines)
- JournalEntry (toujours humaines)
- Prompt (toujours humaines)

## 9. Workflow type

### 9.1 Premier setup

```bash
# 1. Initialiser le vault
cbm-v2 obsidian init

# 2. (Optionnel) Auto-générer les notes modules/routes
cbm-v2 obsidian sync --direction export

# 3. Ouvrir le vault dans Obsidian
#    (l'utilisateur ajoute ses HUMAN NOTES)

# 4. Re-sync pour importer les HUMAN NOTES dans le DB
cbm-v2 obsidian sync --direction import

# 5. Sync régulier (les deux sens)
cbm-v2 obsidian sync
```

### 9.2 Workflow quotidien développeur

```bash
# Le matin : sync pour récupérer les notes collègues (si vault commité)
cbm-v2 obsidian sync

# ... développer, éditer des notes dans Obsidian ...

# Le soir : sync pour pousser ses notes
cbm-v2 obsidian sync

# Commit le vault si partagé en équipe
git add .codebase-memory-vault/
git commit -m "Update human memory notes"
```

### 9.3 Workflow agent IA

```python
# L'agent IA appelle get_module_context(project, "auth")
# → reçoit code + human notes liées

# L'agent crée une nouvelle ADR basée sur son analyse
create_human_note(
    project="my-app",
    label="ADR",
    title="ADR-004: Migrate to Redis sessions",
    body_markdown="...",
    links=[{"cbm_node_id": 1234, "edge": "DECIDES"}]
)

# La note apparaît dans le vault au prochain sync
cbm-v2 obsidian sync --direction export
```

## 10. Sécurité et privacy

### 10.1 Local-first

- Le vault vit dans le repo (ou à un path configurable)
- Aucun appel réseau sortant depuis le sync Obsidian
- Pas de télémétrie sur le contenu des notes

### 10.2 Backup

- Avant chaque write, backup `.bak.<timestamp>`
- Configurable : `v2.obsidian.backupBeforeWrite` (default `true`)
- Les `.bak` ne sont pas commités (`.gitignore`)

### 10.3 Audit log

Toutes les opérations de sync sont loggées dans
`~/.cache/codebase-memory-mcp/v2-audit.log` :

```
2026-07-04T09:30:00Z sync EXPORT Modules/auth.md (modified, backup created)
2026-07-04T09:30:01Z sync IMPORT ADR/ADR-003-use-redis.md (new note)
2026-07-04T09:30:02Z sync LINK ADR-003 DECIDES Module:auth
```

### 10.4 Dry-run

`cbm-v2 obsidian sync --dry-run` affiche les opérations prévues sans rien
écrire. Recommandé avant tout sync en équipe.

## 11. Conflits et résolution

### 11.1 Conflit HUMAN NOTES modifiée des deux côtés

Si la section HUMAN NOTES a été modifiée à la fois dans le vault et dans le DB
(cas rare : DB modifié par agent IA + vault modifié par humain), V2 :

1. Détecte le conflit (diff entre `human_nodes.body_markdown` et vault HUMAN NOTES)
2. Garde la version **vault** (l'humain gagne toujours)
3. Logge le conflit dans `v2-audit.log`
4. Crée un backup `.conflict.<timestamp>` de la version DB

### 11.2 Note supprimée du vault

- Si `human_nodes.obsidian_path` pointe vers un fichier supprimé
- V2 marque `human_nodes.status = 'deprecated'` (ne supprime pas)
- Au prochain sync, si l'utilisateur recrée la note, elle est restaurée

### 11.3 Note supprimée du DB

- Si un `.md` existe dans le vault mais n'a pas de `human_node` correspondant
- V2 propose 3 options :
  1. Importer (créer un `human_node`)
  2. Ignorer (ne plus demander)
  3. Supprimer le fichier

## 12. Limitations actuelles

| Limitation | Plan |
|---|---|
| Pas de plugin Obsidian natif | Optionnel post-V1 |
| Pas de support Obsidian Publish | Non prévu (privacy) |
| Pas de sync temps réel (manuel uniquement) | Phase 3 (watcher) |
| Pas de résolution de templates Obsidian (templater) | Non prévé (trop spécifique) |
| Tags Obsidian parsés mais pas tous interprétés | Convention §6.3 uniquement |
| Pas de support des canvas Obsidian | Non prévu |
