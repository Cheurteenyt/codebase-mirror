# GLM 5.2 — Remédiation des erreurs confirmées et aptitude aux mises à jour

## Verdict exécutif

L'audit a été rejoué sur le commit exact demandé. Le rapport source annonce
« sept défauts », mais son inventaire contient bien **huit findings** : sept
P0/P1 et un P2.

Les huit findings `CONF-R169-001` à `CONF-R169-008` sont corrigés et protégés
par des tests dans le working tree local. Ils ne sont toutefois **pas encore
livrés** : aucun commit, push ou pull request n'a été créé pendant cette passe.
Les résultats ci-dessous sont des snapshots locaux datés, pas un verdict final
sur le working tree courant. Des runs CodeQL PR et push réussis existent pour
la base GitHub déjà commitée, mais aucun de ces runs ne valide les changements
non commités de cette remédiation. La correction de gouvernance ne deviendra
opérationnelle pour ces changements qu'après livraison et observation de leur
SHA exact dans GitHub Actions.

```text
R169B: MERGED / INACTIVE
produit actif: bases legacy <project>.db et <project>.human.db
R169C: HOLD jusqu'à livraison des remédiations et validation CI réelle
mise à jour patch: aptitude locale provisoire, validation distante en attente
upgrade majeur / publication: non certifiés par cette passe
```

## Git

```text
repository: Cheurteenyt/codebase-mirror
base_sha: 9453537d837960e6d3d8c62075fe36a95b34e423
head_sha: 9453537d837960e6d3d8c62075fe36a95b34e423
origin/main: 9453537d837960e6d3d8c62075fe36a95b34e423
remote_parity: HEAD == origin/main après fetch final
branch: main
PR: aucune
working_tree: modifié, non commité
```

Des changements Windows/CI/indexeur/documentation sont apparus concurremment
pendant l'audit. Ils ont été préservés et validés avec les remédiations ; ils ne
sont pas attribués rétroactivement à ce rapport.

## Findings

### CONF-R169-001 — corrigé dans le working tree

- **Reproduction :** deux projets `alpha`/`beta` ayant des bases distinctes ;
  une lecture ou écriture demandée pour `beta` utilisait les handles ouverts au
  démarrage pour `alpha`.
- **Cause :** un unique `HumanMemoryStore` et un unique `CodeGraphReader`
  étaient conservés par `UiServer` malgré le sélecteur multi-projet.
- **Correction :** `ProjectStoreRegistry` ouvre paresseusement les stores du
  projet canonique routé, distribue des leases, borne les handles à 16 entrées,
  évince les entrées inactives, épingle le projet de démarrage et ferme tous les
  handles à l'arrêt. Le projet du body ADR doit correspondre au projet routé.
- **Fichiers principaux :** `v2/src/ui/project-store-registry.ts`,
  `v2/src/ui/server.ts`, `v2/src/ui/routes/human.ts`, `v2/src/ui/types.ts`.
- **Tests comportementaux :** `ui-project-store-routing.test.ts` et
  `ui-project-registry-review-regressions.test.ts` couvrent les DB physiques
  distinctes, l'écriture humaine, les noms invalides, l'éviction et les stores
  paresseux.
- **Durcissement de revue :** un alias de projet n'est accepté que si les
  partitions code **et** humaine sont compatibles ; l'identité est revalidée
  après tout remplacement de fichier et un lease en vol bloque la suppression.

### CONF-R169-002 — corrigé dans le working tree

- **Reproduction :** démarrer sans DB, lancer une première indexation puis
  demander `/api/layout` sans redémarrer le serveur.
- **Cause :** le `codeReader` restait `undefined` après la création de la DB.
- **Correction :** le reader de remplacement est ouvert avant le swap ;
  l'ancien reader n'est fermé qu'après réussite. Le job n'est marqué
  `completed` et la notification n'est envoyée qu'après ouverture du graphe.
  Une DB invalide produit un job `failed` utilisable pour le diagnostic.
- **Fichiers principaux :** `project-store-registry.ts`, `routes/index.ts`,
  `server.ts`, `bridge/sqlite-ro.ts`.
- **Tests comportementaux :** `ui-reader-refresh-after-index.test.ts` couvre la
  première DB, le refresh sans restart et l'échec d'ouverture. Le constructeur
  de `CodeGraphReader` ferme aussi son handle natif si une préparation échoue.
- **Correction d'installation vierge associée :** l'indexeur crée désormais le
  parent de la DB lui-même ; `fresh-cache-directory.test.ts` prouve qu'aucun
  store humain préalable n'est nécessaire.

### CONF-R169-003 — corrigé dans le working tree

- **Reproduction :** l'ancien `/api/process-kill` acceptait un PID client ;
  l'allowlist était contournée sous Windows et raceable ailleurs.
- **Cause :** l'autorisation portait sur un numéro de PID observé plutôt que
  sur un child créé et possédé par cette instance.
- **Correction :** suppression de l'endpoint générique ; un `IndexJob` conserve
  son `ChildProcess` et seul `POST /api/index-jobs/<jobId>/terminate` agit sur ce
  handle. Aucun PID/handle n'est exposé dans le DTO.
- **Fichiers principaux :** `routes/index.ts`, `routes/system.ts`, `types.ts`,
  `server.ts`, `graph-ui/src/api/client.ts`, `ControlTab.tsx`.
- **Tests comportementaux :** processus externe intact, ancien endpoint 404,
  vrai child terminé, job terminé/double terminate refusé, arrêt du serveur.
- **Durcissement de revue :** le contrat termine aussi l'arbre détenu : groupe
  de processus dédié avec `SIGTERM` puis `SIGKILL` sous POSIX, et
  `taskkill.exe /PID <pid> /T /F` sous Windows. Les régressions couvrent un
  descendant récalcitrant lors d'une terminaison API et de l'arrêt serveur.

### CONF-R169-004 — corrigé dans le working tree

- **Reproduction :** POST hostile `text/plain`, Host inattendu, JSON sans token,
  WebSocket hostile/sans token et GET cross-site vers localhost.
- **Cause :** CORS était utilisé comme substitut à une frontière serveur.
- **Correction HTTP :** allowlist Host exacte, Origin same-origin, origine Vite
  uniquement explicite, `application/json`, `Sec-Fetch-Site`, token runtime de
  32 octets, comparaison constante et bootstrap `no-store`. Les requêtes
  Fetch-Metadata `cross-site` sont rejetées avant tout store paresseux.
- **Correction WebSocket :** Host + Origin + token, chemin `/ws`, 64 Kio max,
  compression désactivée et 60 messages/10 s. Le frontend rafraîchit le token
  après une reconnexion/restart serveur.
- **Headers :** CSP avec `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `nosniff`, `no-referrer`, CORP same-origin.
- **Tests comportementaux :** `ui-localhost-origin-security.test.ts`,
  `ui-websocket-origin-security.test.ts`,
  `ui-project-registry-review-regressions.test.ts` et
  `graph-ui/src/hooks/useWebSocket.test.ts`.

### CONF-R169-005 — corrigé dans le working tree

- **Reproduction :** stdout supérieur à la capacité du pipe, plusieurs Mio de
  stderr, child sans fin, descendants conservant stderr et jobs concurrents.
- **Cause :** stdout non consommé, stderr non borné, absence de timeout/quotas
  et enfants ignorés par `stop()`.
- **Correction :** stdout ignoré, tail stderr limitée à 64 Kio, timeout 15 min,
  2 jobs globaux, 1 par identité de projet et refus du doublon. Arrêt : TERM,
  délai borné, KILL. `exit` finalise le job après 50 ms de drainage même si un
  descendant empêche `close`; le chemin terminal reste idempotent.
- **Tests comportementaux :** `ui-index-child-backpressure.test.ts` et
  `ui-index-child-ownership.test.ts` couvrent backpressure, taille, timeout,
  concurrence, shutdown et pipe hérité.

### CONF-R169-006 — corrigé dans le working tree, activation en attente

- **Reproduction :** `cancel-in-progress: true` pouvait annuler le gate après
  le squash et avant les deux dispatches exact-SHA.
- **Correction :** le merge gate n'est plus annulable ; un watchdog
  repository-owned, sans checkout ni merge, inspecte le SHA courant de `main`
  et redéclenche uniquement CI/CodeQL manquants. Il échoue si `main` avance.
- **Fichiers :** `.github/workflows/glm-merge-gate.yml`,
  `.github/workflows/main-exact-sha-watchdog.yml`.
- **Tests :** assertions de gouvernance et sept scénarios runtime dans
  `r169-glm-github-governance.test.ts` et
  `r169-glm-post-merge-watchdog-runtime.test.ts`.
- **Risque résiduel :** seule une fusion suivie d'un vrai run GitHub Actions
  peut prouver permissions, rulesets et dispatches dans le dépôt distant.

Références GitHub officielles :
[workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
[récursion de GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token),
[REST workflow runs](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10).

### CONF-R169-007 — corrigé dans le working tree

- **Cause :** les documents canoniques mélangeaient historique, état fusionné
  et futur produit.
- **Correction :** SHA de merge R169B exact, statut **MERGED / INACTIVE**,
  primitives fd copy+hash/fsync/link no-clobber documentées, bases legacy
  toujours actives et R169C–E explicitement futures. Les affirmations STEP
  obsolètes et la politique Dependabot incorrecte ont été retirées.
- **Fichiers :** `docs/ATOMIC_GENERATION_PUBLICATION.md`,
  `docs/V2_ARCHITECTURE.md`, `docs/V2_CURRENT_STATE.md`, `v2/CHANGELOG.md`.
- **Test :** `r169-canonical-documentation.test.ts` verrouille les affirmations
  canoniques. La référence CLI documente aussi `--dev-origin` et la politique
  de release a été harmonisée avec l'absence actuelle de workflow public.

### CONF-R169-008 — corrigé dans le working tree

- **Reproduction :** `Project` et `project`, hardlinks et chemins alias pouvant
  viser la même DB sur un filesystem insensible à la casse.
- **Cause :** comparaison du nom logique avec `===`.
- **Correction :** comparaison `realpath` puis `dev/ino`; une identité existante
  différente et une existence unilatérale restent distinctes, même sur un OS
  pouvant héberger des volumes sensibles à la casse. Les quotas comparent
  directement l'identité de la DB code ; la suppression vérifie stores/jobs.
- **Tests :** `ui-project-delete-identity.test.ts` et
  `ui-project-registry-review-regressions.test.ts` couvrent casse simulée,
  hardlink, fichiers existants distincts et existence unilatérale.

## Contrat multi-projet final

```text
DB physique: defaultCodeDbPath/defaultHumanDbPath du projet canonique routé
registry: handles lazy, leases, limite 16, LRU idle, startup pinned, closeAll
refresh reader: open replacement -> swap -> close previous
notification: hub attaché au projet canonique du store humain
cross-project: alpha/beta isolés en lecture et écriture physique
suppression: refus si store/job désigne la même identité de fichier
```

## Contrat processus final

```text
ownership: ChildProcess conservé côté serveur
PID arbitraire: aucun endpoint
Windows: handle possédé + taskkill /T /F sur l'arbre
stdout: ignore
stderr: tail <= 64 KiB
timeout: 15 minutes par défaut
concurrence: 2 global / 1 par identité projet / doublon refusé
exit sans close: finalisation après drain 50 ms
shutdown: arbre TERM -> délai global borné -> KILL -> timers/sockets nettoyés
```

## Contrat HTTP/WebSocket final

```text
Host: 127.0.0.1:<port>, localhost:<port>, devOrigin explicite
Origin: same-origin ou devOrigin explicite
Content-Type POST: application/json
CSRF: 256 bits runtime, bootstrap no-store, comparaison constante
Sec-Fetch-Site: same-origin/none pour mutation; cross-site rejeté globalement
WebSocket: Host + Origin + token, 64 KiB, 60 msg/10 s, compression off
headers: CSP, frame-ancestors none, XFO DENY, nosniff, no-referrer, CORP
```

## Validation

### Remédiations ciblées

```text
v2 matrice ciblée consolidée: 19 fichiers / 143 tests PASS / 5.13 s
graph-ui: 11 fichiers / 24 tests PASS
v2 typecheck: PASS
graph-ui typecheck: PASS
v2 build: PASS
graph-ui build: PASS
git diff --check: PASS (avertissements de normalisation CRLF seulement)
```

### Paquet et benchmarks — snapshot local, non final

```text
npm run build:package: PASS
npm pack --dry-run: PASS
tarball: codebase-memory-v2 0.75.0, 272 fichiers, 1.1 MB / 4.5 MB unpacked
bench:incremental:smoke Windows: PASS, 9 scénarios et invariants
bench:publication:smoke Windows: FAIL, STORE_LAYOUT_PERMISSIONS_INSECURE
Docker: NON VÉRIFIÉ, client 29.5.3 présent mais daemon Linux indisponible
```

La version 0.75.0 ci-dessus est celle du paquet construit pendant ce snapshot ;
elle ne remplace pas la version courante déclarée par `v2/package.json` et ne
prouve pas qu'un paquet plus récent a été reconstruit ou publié.

Le benchmark de publication démarre désormais avec une commande npm portable,
mais les primitives R169A/B inactives reposent sur les modes POSIX 0700/0600
et le `fsync` des répertoires. Sous Windows, Node expose ici `0o666` et
`fsyncSync(dirFd)` retourne `EPERM`. Ce contrat exige une conception ACL et
durabilité Windows ; il n'a pas été masqué par un skip.

### Non-régression R169A/B sur cet hôte Windows

```text
11 fichiers
509 tests: 245 PASS / 264 FAIL
2 erreurs non gérées
durée: 80.86 s
causes dominantes: modes POSIX, fsync de répertoire, symlink EPERM,
                   exécutable node_modules/.bin/tsx sans suffixe Windows
```

Snapshot de la suite V2 complète avant les derniers correctifs ciblés :

```text
128 fichiers: 77 PASS / 51 FAIL
1898 tests: 1351 PASS / 547 FAIL
2 erreurs non gérées
durée: 82.27 s
```

Le snapshot final du 2026-07-15 a observé **1 487 PASS, 534 FAIL
et 2 erreurs non gérées**. Les snapshots restent non verts et ne doivent
pas être présentés comme un résultat final sans nouvelle exécution sur le SHA
à livrer.

Ces échecs ne sont pas attribués aux remédiations UI : la matrice ciblée passe.
Ils empêchent néanmoins de déclarer la totalité du dépôt Windows-green.

### Dépendances

```text
npm audit v2: 0 vulnérabilité / 174 dépendances
npm audit graph-ui: 0 vulnérabilité / 343 dépendances
npm outdated: aucune mise à jour compatible dans les plages déclarées
  v2: 5 migrations majeures restantes
  graph-ui: 5 migrations majeures restantes
lockfiles: package-lock v3 dans v2 et graph-ui
npm ci / build-package: reproductibles
```

Les patches compatibles ont été appliqués. Les autres écarts directs sont des changements majeurs à isoler
(`better-sqlite3`, Commander, TypeScript, Vite/plugin React, jsdom,
lucide-react et types Node).

### Réindexation Codebase Memory

```text
réindexation complète codebase-mirror: PASS / 2,614 s / 23 workers
467 fichiers / 8 978 nœuds / 16 709 arêtes / 0 erreur
index incrémental après finalisation: PASS / 613 ms
7 fichiers indexés / 460 ignorés / 7 nœuds extraits / 5 411 arêtes extraites / 0 erreur
```

## Aptitude aux mises à jour

### Ce que le snapshot local a validé

- `git fetch` fonctionne et la base auditée était en parité exacte avec
  `origin/main`.
- Les deux projets npm ont des lockfiles v3 et `npm ci` reproductible.
- Le paquet reconstruit l'UI, compile le backend, copie/vérifie les assets et
  `prepack` rejoue ce pipeline.
- L'audit npm ne remonte aucune vulnérabilité connue.
- Le nouveau smoke Windows protège les chemins projet, worker, MCP,
  graph-status et benchmark incrémental.

### État après remédiation

Les cinq premiers freins de maintenance ont reçu des corrections ou une
configuration dans le working tree de remédiation ; leur validation distante
sur le SHA à livrer reste en attente :

1. minimum Node 22.12.0 déclaré et configuré dans les jobs CI Linux/Windows,
   avec Node 24 LTS pour le développement et les trois stages Docker ; le run
   distant de ces modifications reste à observer ;
2. `.node-version`, `.nvmrc` et `engines.node` alignés ; les champs
   `packageManager: npm@10.9.0` restent des hints d'authoring/Corepack, pas une
   contrainte runtime, et les lockfiles v3 sont compatibles avec npm 10 et 11 ;
3. Dependabot réactivé avec groupes minor/patch hebdomadaires, limites par
   écosystème et ignore semver-major pour Actions, V2, Graph UI et Docker ;
4. patches compatibles appliqués (`tsx`, `web-tree-sitter`, `ws`) et audits npm
   à zéro vulnérabilité connue ;
5. workflows CI paquet et Docker renforcés par un vrai démarrage HTTP de l'UI
   finale ; le paquet est aussi installé et lancé localement depuis un
   répertoire de travail arbitraire, tandis que le run distant modifié reste à
   observer.

Les limites restantes sont explicites : les tags Docker Node 24 ne sont pas
figés par digest, aucun workflow de release exact-tag ne publie encore
checksums/provenance, les migrations majeures restent volontairement séparées,
et R169A/B demeure POSIX-only et inactif. La montée vers jsdom 29 demandera en
particulier de relever le plancher Node à 22.13 ou plus.

Aucun score final n'est attribué avant la livraison et l'observation du SHA
exact. Les preuves locales ciblées soutiennent provisoirement la maintenance
patch ; les upgrades majeurs et la publication publique ne sont pas certifiés
par cette passe.

## Ordre recommandé

1. Livrer ces remédiations sur une branche/PR et observer CI, CodeQL et le
   watchdog sur leur SHA exact. Les runs CodeQL réussis déjà observés sur la
   base commitée ne valident pas le working tree non commité.
2. Traiter les majors par lots isolés : `better-sqlite3`, Commander, TypeScript,
   puis frontend Vite/plugin React/jsdom/lucide, en relevant le plancher Node
   lorsque jsdom l'exige.
3. Épingler les images Docker par digest si la reproductibilité binaire prime
   sur le rafraîchissement automatique des patches.
4. Créer un workflow release exact-tag : pack/install depuis cwd arbitraire,
   UI HTTP, Docker non-root + UI HTTP, notes, checksums et provenance.
5. Avant R169C, décider et tester le contrat ACL/fsync Windows des générations,
   puis rejouer toute la matrice crash/concurrence R169E.
