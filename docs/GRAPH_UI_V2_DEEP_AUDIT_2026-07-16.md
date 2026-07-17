# Graph UI V2 — audit approfondi du 16 juillet 2026

## Statut et règle de preuve

Cet audit décrit **l’artefact 0.77.0-alpha.1 reconstruit, réindexé et servi
localement le 16 juillet 2026**. La révision a ensuite passé tous les gates de
la [PR #25](https://github.com/Cheurteenyt/codebase-mirror/pull/25) avant son
intégration à `main` au commit `63403c5`.

Trois niveaux de preuve sont distingués :

- **CODE** : comportement directement observable dans le code actuel ;
- **TEST EXÉCUTÉ** : la commande et le total courant sont consignés plus bas ;
- **RUNTIME MESURÉ** : le paquet reconstruit a été servi sur le projet réindexé ;
- **NON COMPARÉ** : aucune conclusion V1/V2 n’est admise sans le même graphe et
  le même protocole des deux côtés.

Les mesures backend/transport V2 de ce document proviennent de
`npm run bench:graph-ui -- --project codebase-mirror --query GraphCanvas --runs 7`
sur le paquet final local. Elles ne sont pas substituées à un benchmark V1/V2
strictement comparable. Les anciennes mesures restent dans
[PERFORMANCE_TOKEN_UI_AUDIT_2026-07-15.md](PERFORMANCE_TOKEN_UI_AUDIT_2026-07-15.md).

## Verdict exécutif

La V2 a maintenant une base plus rigoureuse que la V1 pour construire une carte
d’architecture exploitable :

- hiérarchie domaine → communauté → nœud ;
- carte principale représentative et explicitement bornée ;
- catalogue exact des domaines de premier niveau ;
- recherche exacte sur tout le projet ;
- voisinage direct exact et paginé ;
- regroupement des arêtes et niveaux de détail dépendant du zoom ;
- navigation réversible, interaction souris/tactile/clavier et tests ciblés.

Cela ne suffit pas encore à déclarer que la V2 « bat la V1 partout ».

Les trois réserves majeures sont :

1. **La perception visuelle n’est pas encore une preuve.** La V1 possède une
   identité forte fondée sur la profondeur d’appel, les étoiles et une
   optimisation locale 3D. La V2 est plus explicable, mais sa supériorité
   esthétique et sa vitesse de compréhension doivent être validées en runtime.
2. **Exact et représentatif coexistent.** C’est la bonne architecture pour les
   grands graphes, mais chaque nombre, surface, filtre et sélection doit annoncer
   clairement son périmètre. Une géométrie échantillonnée ne doit jamais être
   lue comme une représentation exhaustive.
3. **La V2 est maintenant mesurée, mais pas encore comparée à armes égales.**
   Sur 9 710 nœuds, la recherche exacte est à 18,309 ms p50 et le voisinage à
   1,106 ms p50 ; le layout gzip p50 est 111,670 ms pour 56 763 octets. Les
   coûts navigateur et la V1 doivent encore être mesurés sur le même graphe.

La direction recommandée n’est donc ni « tout afficher » ni « simplifier la
carte ». Elle est : **une carte progressive, représentative au niveau global,
exacte à la demande, et honnête sur chaque transition**.

## Périmètre inspecté

### V1 de référence

- [layout3d.h](../v1-reference/src/ui/layout3d.h), contrat overview/detail ;
- [layout3d.c](../v1-reference/src/ui/layout3d.c), placement 3D, profondeur
  d’appel, Barnes–Hut, encodage stellaire et sélection bornée ;
- [http_server.c](../v1-reference/src/ui/http_server.c), exposition du layout.

La comparaison V1 porte surtout sur son moteur de layout disponible dans le
répertoire de référence. Le frontend V1 est distribué sous forme d’assets
embarqués/générés ; cet audit ne prétend donc pas avoir prouvé toute sa parité
d’interaction ou d’accessibilité à partir des sources frontend.

### V2 actuelle

- [sqlite-ro.ts](../v2/src/bridge/sqlite-ro.ts), couverture des domaines,
  sélection des arêtes, recherche et voisinage ;
- [graph.ts](../v2/src/ui/routes/graph.ts), contrat HTTP du layout, recherche et
  voisinage ;
- [GraphCanvas.tsx](../graph-ui/src/components/GraphCanvas.tsx), simulation,
  rendu, niveaux de détail et interactions ;
- [GraphTab.tsx](../graph-ui/src/components/GraphTab.tsx), filtres, navigation,
  rafraîchissement et responsive ;
- [Sidebar.tsx](../graph-ui/src/components/Sidebar.tsx), arbre et recherche ;
- [NodeDetailPanel.tsx](../graph-ui/src/components/NodeDetailPanel.tsx), détail
  et connexions exactes ;
- [useExactNodeSearch.ts](../graph-ui/src/hooks/useExactNodeSearch.ts) et
  [useExactNeighborhood.ts](../graph-ui/src/hooks/useExactNeighborhood.ts),
  annulation, pagination et reprise ;
- [build-package.mjs](../v2/scripts/build-package.mjs), intégration de l’UI dans
  le paquet npm.

## Ce que « meilleur que la V1 » doit vouloir dire

La comparaison doit être multidimensionnelle. Une carte peut être plus belle
mais moins fidèle, plus rapide mais moins lisible, ou exacte mais inutilisable.

| Axe | Question vérifiable |
|---|---|
| Fidélité | L’utilisateur sait-il toujours ce qui est exact, échantillonné ou masqué ? |
| Compréhension | Peut-il identifier domaines, dépendances majeures et anomalies plus vite ? |
| Navigation | Peut-il passer d’une vue globale à un symbole exact sans perdre son contexte ? |
| Performance | Latence, transfert, long tasks, fluidité, CPU refroidi et mémoire sont-ils meilleurs ? |
| Économie de tokens | Le workflow évite-t-il réellement des commandes et des sorties modèle ? |
| Accessibilité | Le même travail reste-t-il possible au clavier et avec une alternative au canvas ? |
| Maintenabilité | Une mise à jour frontend/backend produit-elle un paquet cohérent et testable ? |
| Régression | Les états de filtre, sélection, rafraîchissement et pagination restent-ils cohérents ? |

La V2 ne doit être annoncée supérieure que lorsque les critères d’acceptation
de ces axes sont définis puis mesurés.

## Comparaison honnête V1 / V2

| Dimension | V1 observée dans le code | V2 actuelle | Conclusion honnête |
|---|---|---|---|
| Structure initiale | Clé formée des trois premiers segments de chemin, puis placement sur anneau | Domaine de premier segment, communautés de chemin, packing déterministe | V2 est plus explicite et navigable ; avantage structurel |
| Raffinement | 40 itérations locales, répulsion Barnes–Hut, attraction des arêtes et rappel aux ancres | d3-force côté navigateur, ancres serveur, forces limitées aux liens intra-communauté | Les deux préservent une structure initiale ; performance non comparée |
| Dimension sémantique | Axe Z dérivé de la profondeur d’appel | Carte 2D ; dépendances macro matérialisées par bundles et styles | V1 conserve une force conceptuelle sur la profondeur ; V2 doit proposer un équivalent lisible si ce signal est important |
| Encodage visuel | Couleur stellaire et taille liées au degré/type | Couleur par type ou statut, taille bornée, contours de sélection, labels domaine/communauté | V1 a une identité plus singulière ; V2 apporte plus d’explication textuelle |
| Vue globale | Nombre maximal de nœuds et total global | Overview frontend fixé à 1 000 représentants, stratégie de couverture et métadonnées de troncature | V2 est plus honnête sur son échantillon |
| Drill-down | Le contrat déclare overview/detail, centre et rayon | Recherche projet exacte, voisinage exact, scopes et fil d’Ariane | Dans l’implémentation V1 inspectée, level, center_node et radius sont ignorés ; avantage opérationnel V2 |
| Domaines | Déduits implicitement par l’anneau | Géométrie par domaines/communautés et catalogue exact des domaines de premier niveau | Avantage V2, avec la réserve que la géométrie reste échantillonnée |
| Arêtes | Arêtes induites brutes sur les nœuds retenus | Forêt de couverture prioritaire, double plafond directionnel, bundles macro puis arêtes locales au zoom | Coût V2 courant mesuré ; comparaison V1 dense encore requise |
| Recherche | Non démontrée dans le moteur de layout inspecté | Recherche littérale, projet-scopée, classée et paginée | Avantage fonctionnel V2 |
| Détail exact | Non démontré dans ce contrat de layout | Totaux de degré exacts et pages de voisinage exactes | Avantage fonctionnel V2 |
| Accessibilité | Non démontrable avec les sources frontend disponibles | Arbre ARIA, recherche DOM exacte, canvas application à cibles virtuelles bornées, focus/modal clavier | Avantage de preuve V2 ; lecteur d’écran réel encore requis |
| Mise à jour | C et assets embarqués | React/TypeScript séparé, budgets, build/copie contrôlés et smoke du tarball installé | Avantage de garde V2 ; exécution DOM CI encore à automatiser |
| Performance | C natif et calcul serveur, mais récupération/filtrage de nombreuses arêtes et optimisation locale | SQLite + TypeScript serveur, canvas et d3 côté navigateur | Aucun vainqueur sans benchmark courant strictement comparable |

### Point important sur le « detail » V1

[layout3d.h](../v1-reference/src/ui/layout3d.h) annonce deux niveaux et des
paramètres center_node/radius. Dans
[layout3d.c](../v1-reference/src/ui/layout3d.c), level, center_node et radius
sont explicitement ignorés avant la requête bornée. Il faut donc comparer la V2
à l’implémentation V1 réelle, pas seulement à son commentaire d’interface.

### Ce que la V1 fait encore bien

- elle donne immédiatement une impression de graphe vivant et profond ;
- elle encode le degré sous forme d’étoile, lisible sans ouvrir un panneau ;
- elle utilise la profondeur d’appel comme axe spatial ;
- elle combine structure de répertoire et optimisation locale ;
- son langage visuel est cohérent et distinctif.

La V2 ne doit pas copier la 3D par principe. Elle doit récupérer les qualités
utiles : hiérarchie visible, flux directionnel, importance des hubs et identité
graphique forte.

## Contrat de vérité : exact contre représentatif

Le tableau suivant doit devenir la référence de vocabulaire du produit.

| Surface V2 | Périmètre actuel | Statut |
|---|---|---|
| Nœuds de /api/layout | Sous-ensemble borné et couvert du projet | **Représentatif** |
| Arêtes renvoyées par /api/layout | Arêtes induites du sous-ensemble, éventuellement plafonnées | **Représentatif**, avec statistiques de troncature |
| layout.domains et layout.clusters | Géométrie et comptes des nœuds renvoyés | **Représentatif** |
| layout.domain_catalog | Tous les nœuds regroupés par domaine de premier niveau | **Exact pour ce niveau seulement** |
| Surface et rayon d’un domaine | Calculés à partir des représentants | **Représentatif**, pas proportion exhaustive |
| Bundles affichés | Agrégation des arêtes renvoyées | **Représentatif** |
| Arbre du Sidebar | Reconstruit depuis les nœuds visibles | **Représentatif** |
| Comptes de filtres | Calculés sur l’overview reçu | **Représentatif** |
| Recherche /api/node-search | Correspondances littérales dans tout le projet, paginées | **Exact au moment de chaque requête** |
| Degrés d’un nœud enrichi | Comptages dans la DB du projet | **Exact au moment de la requête** |
| /api/neighborhood | Arêtes incidentes directes, paginées | **Exact au moment de chaque requête** |
| /api/scope | Nœuds et arêtes internes d’un domaine/dossier, paginés | **Exact à une révision**, partiel tant que `next_cursor` existe |
| Liste déjà chargée dans le détail | Pages exactes chargées jusque-là | **Partielle mais explicitement paginée** |

### Architecture de divulgation progressive

    Projet complet
        |
        +-- catalogue exact des domaines et totaux
        |
        +-- carte représentative bornée
                |
                +-- domaine représenté
                |       |
                |       +-- communautés représentées
                |
                +-- recherche exacte projet
                |       |
                |       +-- nœud éventuellement absent de la carte
                |
                +-- nœud sélectionné
                        |
                        +-- voisinage direct exact paginé

Ce modèle est adapté aux grands graphes parce qu’il évite de transférer et
dessiner tout le projet. Il reste correct uniquement si l’interface ne confond
jamais les deux niveaux.

## État actuel de la V2

### Acquis de conception

1. **Hiérarchie stable.** Le layout serveur produit des domaines, communautés
   et positions déterministes. Les breadcrumbs utilisent des clés de chemin,
   pas seulement des identifiants numériques locaux à une réponse.
2. **Couverture de l’architecture.** La sélection équilibre les labels, conserve
   des hubs, réserve des candidats de code mort et injecte un représentant
   stable pour chaque domaine absent.
3. **Catalogue exact des domaines.** La requête agrège tous les nœuds du projet
   par premier segment de chemin sans transférer tout le graphe.
4. **Arêtes honnêtes.** Le backend calcule le nombre d’arêtes induites, applique
   des plafonds entrants/sortants, préserve d’abord une forêt de connexion et
   publie la troncature par type.
5. **Niveaux de détail visuels.** Le canvas affiche des bundles de domaines à
   l’échelle globale, des bundles de communautés à l’échelle intermédiaire et
   les arêtes brutes à l’échelle locale.
6. **Physique confinée.** Les arêtes inter-communautés ne tirent pas la
   simulation locale hors de la structure décidée par le serveur.
7. **Réutilisation de simulation.** Les objets d3 et leurs positions sont
   conservés lors des filtres/rafraîchissements compatibles ; le dessin des
   ticks est regroupé via requestAnimationFrame.
8. **Recherche exacte progressive.** Le Sidebar garde un retour local immédiat,
   lance une recherche projet après debounce, annule les requêtes obsolètes et
   sait charger la suite.
9. **Voisinage exact progressif.** Le panneau conserve le contexte
   représentatif pendant le chargement exact, fusionne les pages et distingue
   erreur initiale et erreur de pagination.
10. **Interactions robustes.** Souris, tactile, pinch, focus, raccourcis de
    zoom/pan, Escape, fil d’Ariane, resize clavier et reduced-motion sont pris
    en compte dans le code.
11. **Packaging unifié.** build:package construit l’UI, compile le backend,
    copie les assets et vérifie leurs références avant empaquetage.

### Tests et gates exécutés sur l’artefact courant

| Risque couvert | Preuve exécutée |
|---|---|
| Réutilisation/arrêt/rechauffage de d3 | GraphCanvas.test.tsx |
| Bundles macro et exclusion des liens macro de la physique | GraphCanvas.test.tsx |
| Souris, tap, pan tactile, pinch et annulation de drag | GraphCanvas.test.tsx |
| Fit initial, reset et reduced-motion | GraphCanvas.test.tsx |
| Rafraîchissement et identité stable des breadcrumbs | GraphTab.reconcile.test.tsx |
| Navigation ARIA de l’arbre | Sidebar.test.tsx |
| Recherche exacte, debounce, pagination et stale requests | useExactNodeSearch.test.ts |
| Voisinage exact, fusion, retry et unmount | useExactNeighborhood.test.ts |
| Scope exact, fusion paginée, révision, retry et recentrage de frame | useExactScope.test.ts, GraphCanvas.test.tsx, GraphTab.reconcile.test.tsx |
| Honnêteté du détail partiel/exact et auto-boucles | NodeDetailPanel.test.tsx |
| ResizeHandle clavier et pointerCancel | ResizeHandle.test.tsx |
| Packing, couverture de domaines et métadonnées du layout | tests UI V2 côté backend |

Résultats courants : Graph UI **18 fichiers / 138 tests**, régressions ciblées
scope/SQLite/contrat CI **3 fichiers / 31 tests**, deux typechecks, deux builds
et `build:package` réussis. Le build Graph UI impose les budgets gzip. Le paquet
servi a ensuite été contrôlé dans le navigateur : overview, drill-down clavier,
scope exact paginé dans le même canvas, recentrage automatique, recherche
exacte, voisinage, refresh avec sélection préservée et restauration du focus.

La CI de la PR #25 a confirmé le backend, le frontend, Windows, le tarball
installé, Docker et CodeQL. Le smoke du tarball a indexé une fixture TypeScript,
chargé les assets JS/CSS du paquet et exercé layout, recherche et voisinage sur
une révision commune.

Budget courant : Graph **34,78 / 40 Kio**, entrée **70,87 / 80 Kio**, CSS total
**11,68 / 18 Kio**, JavaScript manifeste **118,05 / 125 Kio** (gzip). Le moteur
`d3-*` stable est isolé dans un chunk asynchrone de **5,57 Kio gzip** et reste
compté dans le budget manifeste. Les
assets sont résolus par `index.html` et le manifeste Vite, pas par ordre de
répertoire ou nom supposé.

La suite backend Windows exhaustive a aussi été lancée : 1 508 tests passent,
mais 534 tests POSIX-only échouent, avec deux erreurs non gérées, sur `chmod`,
`ls`, Bash, permissions, exécutables `.bin` sans extension et symlinks Unix.
Ces échecs ne touchent pas le périmètre Graph UI et ne sont pas masqués ; la
suite Linux de la PR reste l’autorité pour ces scénarios.

## Lacunes et risques de régression

### R1 — Géométrie représentative, totaux exacts

Le rayon d’un domaine et le nombre de communautés visibles viennent de
l’échantillon, alors que le label peut afficher un total exact du projet. Deux
domaines de taille réelle très différente peuvent donc occuper des surfaces
proches.

Risque : l’utilisateur lit la surface comme une grandeur exacte.

Action : afficher explicitement « shown » et « total » partout, puis décider si
la surface doit encoder la taille représentée, la taille exacte, ou aucune des
deux. Cette décision doit être testée visuellement sur monorepo, repo plat et
repo avec de nombreux petits domaines.

### R2 — Communautés et arbre non exhaustifs

Le catalogue exact ne couvre actuellement que les domaines de premier niveau.
Les communautés, l’arbre du Sidebar, leurs comptes et leurs sélections restent
issus des représentants.

Risque : un dossier absent de l’échantillon semble absent du projet ; sélectionner
un domaine peut être interprété comme sélectionner tous ses nœuds.

Action : soit ajouter un endpoint exact et paginé de scope/directory, soit
qualifier systématiquement ces surfaces comme « represented ».

### R3 — Fermé : pagination liée à un snapshot révisé

Layout, recherche et voisinage exposent une révision opaque. Chaque réponse est
lue dans un snapshot SQLite ; les curseurs portent cette révision et une page
périmée reçoit HTTP 409 `GRAPH_REVISION_MISMATCH`. Les hooks jettent toutes les
pages accumulées avant de redémarrer. Les transitions projet/requête/nœud sont
également masquées synchroniquement pour ne jamais peindre une ancienne frame.

### R4 — Coût de recherche exact

La recherche littérale applique des LIKE substring et des normalisations de
chemin ; elle calcule aussi le total exact. Ces opérations peuvent scanner tous
les nœuds d’un projet, et le total est recalculé sur chaque page.

Risque : latence visible sur très grands graphes et travail répété lors de la
frappe.

Action : mesurer avant d’optimiser ; envisager ensuite le total uniquement sur
la première page, un cache lié à la révision, ou un index de recherche dont la
sémantique reste strictement identique au fallback littéral.

### R5 — Coût des arêtes induites avant plafonnement

Le backend doit connaître toutes les arêtes induites du sous-ensemble pour
publier un total honnête, puis les trie et applique les plafonds.

Risque : un overview de taille bornée peut néanmoins être coûteux sur un graphe
très dense.

Action : ajouter un fixture dense et mesurer temps SQL, allocations et taille
intermédiaire ; ne changer l’algorithme qu’avec une preuve que le coût domine.

### R6 — Budget fixe de 1 000 nœuds

Le frontend demande actuellement 1 000 nœuds quel que soit le matériel, la
densité, la taille de viewport ou le nombre d’arêtes.

Risque : sous-utilisation d’une machine rapide, surcharge d’un appareil faible,
et qualité variable selon la topologie.

Action : définir des profils de budget basés sur les mesures, pas seulement sur
le nombre de nœuds. Le nombre de liens, le coût de labels et le DPR comptent
également.

### R7 — Partiellement fermé : navigation virtuelle bornée

Le canvas est maintenant une application interactive. D/C/N et leurs variantes
Shift parcourent des cibles virtuelles bornées de domaines, communautés et
nœuds ; Enter/Espace active la cible, un focus visuel est peint et un live
status annonce la position. L’arbre et la recherche exacte restent les parcours
DOM exhaustifs, sans créer des milliers d’éléments.

Reste : validation avec un lecteur d’écran réel et définition d’un parcours
exact de dossier complet.

### R8 — Contraste, petites cibles et dépendance à la couleur

Plusieurs textes utilisent des tailles de 9–11 px et une opacité faible sur fond
sombre. Type, statut et importance reposent souvent sur la couleur.

Risque : échec WCAG, fatigue visuelle, différence illisible sur écran peu
contrasté ou avec déficience de vision des couleurs.

Action : audit de contraste calculé, test à 200 %, motifs/formes secondaires
pour les états, et tailles minimales de cible cohérentes.

### R9 — Fermé : revalidation d’un résultat hors overview

La sélection exacte survit au refresh uniquement après revalidation sur la
nouvelle révision. Une notification WebSocket incrémente aussi un epoch pour
couvrir les changements hors échantillon et les échecs de refresh. Un nœud
supprimé ferme le détail ; un nœud seulement absent de l’overview reste ouvert.

### R10 — Filtres de l’overview contre résultats exacts

Les filtres de labels/statuts et leurs compteurs portent sur l’overview. La
recherche exacte peut renvoyer un nœud dont le type a été désactivé.

Risque : comportement perçu comme contradictoire.

Règle actuelle : la recherche exacte ignore les filtres représentatifs et se
présente explicitement comme recherche projet complète. Un filtrage exact côté
serveur reste une amélioration optionnelle, pas une ambiguïté silencieuse.

### R11 — Flux inter-domaines non utilisé par la géométrie

La physique locale ignore volontairement les liens inter-communautés. Cela
préserve la carte d’architecture, mais des domaines fortement couplés ne se
rapprochent pas automatiquement.

Risque : la carte privilégie le système de fichiers au détriment de
l’architecture dynamique.

Action : proposer éventuellement deux modes mesurables — structure de chemin et
flux de dépendances — plutôt qu’un compromis implicite.

### R12 — Partiellement fermé : smoke du tarball installé

La CI installe maintenant le tarball dans un répertoire temporaire, indexe une
fixture TypeScript, démarre le serveur empaqueté depuis un cwd arbitraire, puis
vérifie HTML, chargement HTTP des assets JS/CSS avec leurs types, layout,
catalogue exact, recherche, voisinage et révision partagée.

Reste : un smoke navigateur automatisé qui exécute réellement le JavaScript et
valide une interaction DOM dans la CI. Le contrôle navigateur a été fait
localement sur cet artefact, mais n’est pas encore un gate automatique.

## Performance : mesures V2 warm et protocole V1/V2 restant

### Règles du benchmark V1/V2

- même machine, même alimentation et même configuration ;
- même projet, même DB/index et même nombre de nœuds/arêtes ;
- builds propres de la révision réellement testée ;
- alternance V1/V2 pour réduire le biais de cache ;
- mesures cold process et warm persistent séparées ;
- plusieurs tailles et densités de graphe ;
- médiane, p95 et dispersion, pas seulement le meilleur passage ;
- navigateur, DPR, viewport et extensions documentés ;
- aucune conclusion à partir du seul temps interne affiché par une CLI.

### Fixtures à préparer

| Fixture | Nœuds | Arêtes | Domaines | Profil |
|---|---:|---:|---:|---|
| Petit projet réel | [À MESURER] | [À MESURER] | [À MESURER] | [À DÉCRIRE] |
| Projet courant | 9 710 | 17 940 | 7 | dépôt mixte TS/TSX/C/Markdown, 479 fichiers |
| Grand monorepo | [À MESURER] | [À MESURER] | [À MESURER] | [À DÉCRIRE] |
| Synthétique dense | [À MESURER] | [À MESURER] | [À MESURER] | stress arêtes |
| Nombreux domaines | [À MESURER] | [À MESURER] | [À MESURER] | stress packing/labels |

### Backend et transport

| Mesure | V1 | V2 | Budget/décision |
|---|---:|---:|---|
| Layout cold p50 / p95 | [À MESURER] | [À MESURER] | démarrage process séparé requis |
| Layout warm identity p50 / p95 | [À MESURER] | 124,493 / 147,057 ms | 7 runs, cache primé |
| Layout warm gzip p50 / p95 | [À MESURER] | 111,670 / 128,241 ms | 7 runs, cache primé |
| Recherche première page p50 / p95 | N/A ou [À MESURER] | 18,309 / 22,759 ms | 243 matches, 50 renvoyés |
| Recherche page suivante p50 / p95 | N/A ou [À MESURER] | [À MESURER] | [À DÉCIDER] |
| Voisinage première page p50 / p95 | [À MESURER] | 1,106 / 1,923 ms | 1 connexion sur l’ancre mesurée |
| Payload layout JSON brut | [À MESURER] | 491 075 octets | 1 000 nœuds / 1 468 arêtes |
| Payload layout gzip | [À MESURER] | 56 763 octets | −88,44 % ; Brotli non mesuré |
| Payload recherche / voisinage gzip | N/A ou [À MESURER] | 1 805 / 728 octets | sorties exactes ciblées |
| Revalidation ETag | [À MESURER] | HTTP 304, 0 octet de corps | contrat cache vérifié |
| Working set / privé serveur warm | [À MESURER] | 108,60 / 83,24 Mio | process Node local |
| CPU serveur après stabilisation | [À MESURER] | 0,000 s sur 5 s | inactif après refroidissement |

Ces chiffres sont **V2 warm uniquement** : le script prime les caches, exécute
identity puis gzip séquentiellement, et ne mesure ni cold process, ni deuxième
page, ni V1. Ils prouvent le comportement de l’artefact courant, pas une
supériorité comparative complète.

### Navigateur

| Mesure | V1 | V2 | Budget/décision |
|---|---:|---:|---|
| Navigation → carte visible | [À MESURER] | [À MESURER] | [À DÉCIDER] |
| Temps de simulation avant refroidissement | [À MESURER] | [À MESURER] | [À DÉCIDER] |
| Long task maximale au chargement | [À MESURER] | [À MESURER] | [À DÉCIDER] |
| FPS pan/zoom overview | [À MESURER] | [À MESURER] | [À DÉCIDER] |
| FPS pan/zoom local avec arêtes brutes | [À MESURER] | [À MESURER] | [À DÉCIDER] |
| CPU navigateur après refroidissement | [À MESURER] | [À MESURER] | proche de l’inactif |
| Heap navigateur stabilisé | [À MESURER] | [À MESURER] | [À DÉCIDER] |
| Délai clic domaine → vue focalisée | [À MESURER] | [À MESURER] | [À DÉCIDER] |
| Délai recherche → résultat exact | N/A ou [À MESURER] | [À MESURER] | [À DÉCIDER] |

### Qualité perceptuelle

La beauté ne se résume pas aux FPS. Faire exécuter les mêmes tâches sans
indiquer la version :

| Tâche | V1 | V2 | Observation |
|---|---:|---:|---|
| Identifier les trois plus grands domaines | [TEMPS/ERREURS] | [TEMPS/ERREURS] | [À COMPLÉTER] |
| Trouver un symbole absent de l’overview | [TEMPS/ERREURS] | [TEMPS/ERREURS] | [À COMPLÉTER] |
| Comprendre la direction d’un flux majeur | [TEMPS/ERREURS] | [TEMPS/ERREURS] | [À COMPLÉTER] |
| Retrouver le chemin après un drill-down | [TEMPS/ERREURS] | [TEMPS/ERREURS] | [À COMPLÉTER] |
| Identifier un hub ou un code mort | [TEMPS/ERREURS] | [TEMPS/ERREURS] | [À COMPLÉTER] |

Le retour utilisateur « la V1 paraît plus correcte » est un signal produit
important, mais pas encore une mesure. Il doit être transformé en critères :
séparation des groupes, stabilité, lisibilité des flux, hiérarchie, densité,
contraste et temps pour accomplir ces tâches.

## Économie de tokens et de commandes

### Ce que la V2 peut réellement économiser

- la carte représentative évite le transfert initial du graphe complet ;
- le catalogue de domaines répond sans télécharger chaque nœud ;
- la recherche exacte évite une succession de recherche locale, lecture de
  fichiers et commandes de comptage pour localiser un symbole ;
- le voisinage exact évite de charger toutes les arêtes ou d’exécuter plusieurs
  requêtes directionnelles ;
- les métadonnées de fidélité évitent à l’agent de deviner si une absence est
  réelle ou due à l’échantillon.

### Limite fondamentale

Une UI affichée à un humain ne réduit pas automatiquement les tokens consommés
par un modèle. Il faut mesurer le workflow réellement utilisé par Codex/MCP :

- nombre d’appels et de commandes ;
- octets HTTP ou JSON-RPC transférés ;
- taille du texte réellement injecté au modèle ;
- tokens calculés avec un tokenizer identifié ;
- temps jusqu’à l’information correcte ;
- erreurs ou appels correctifs évités.

Comparer séparément :

1. shell/recherche/lecture manuelle ;
2. endpoints Graph UI ciblés ;
3. tool MCP compact équivalent ;
4. workflow combiné UI + MCP.

| Scénario | Commandes/appels | Octets | Tokens modèle | Temps | Erreurs |
|---|---:|---:|---:|---:|---:|
| Localiser un symbole hors overview — baseline | [À MESURER] | [À MESURER] | [À MESURER] | [À MESURER] | [À MESURER] |
| Localiser un symbole — recherche exacte V2 | [À MESURER] | [À MESURER] | [À MESURER] | [À MESURER] | [À MESURER] |
| Obtenir appels entrants/sortants — baseline | [À MESURER] | [À MESURER] | [À MESURER] | [À MESURER] | [À MESURER] |
| Obtenir le voisinage exact V2 | [À MESURER] | [À MESURER] | [À MESURER] | [À MESURER] | [À MESURER] |
| Comprendre l’architecture — baseline | [À MESURER] | [À MESURER] | [À MESURER] | [À MESURER] | [À MESURER] |
| Comprendre l’architecture — overview + domaines V2 | [À MESURER] | [À MESURER] | [À MESURER] | [À MESURER] | [À MESURER] |

Ne pas confondre JSON compact contre JSON indenté, octets compressés et tokens
de modèle : ce sont trois mesures différentes.

## Accessibilité

### Points positifs dans le code

- tablist et tabpanels au niveau application ;
- canvas focusable avec instructions, pan, zoom et fit clavier ;
- arbre ARIA avec roving tabindex et navigation par flèches/Home/End ;
- expansion et sélection séparées ;
- résultats de recherche et connexions sous forme de boutons DOM ;
- fil d’Ariane et remontée par Escape ;
- focus envoyé sur le titre lors du changement de nœud ;
- séparateurs redimensionnables au clavier ;
- reduced-motion respecté pour les mouvements de caméra ;
- zones tactiles et gestes explicitement gérés.

### Ce qui doit encore être prouvé

- ordre de focus complet sur desktop et mobile ;
- annonce correcte des chargements, erreurs, pages et changements de scope ;
- navigation exacte d’un symbole non représenté sans dépendre du canvas ;
- contraste WCAG des textes à faible opacité ;
- fonctionnement à 200 % et 400 % de zoom ;
- alternatives à la couleur pour type/statut/sélection ;
- lecteur d’écran réel sur arbre, recherche, breadcrumb et détail ;
- absence de piège focus lors d’un refresh WebSocket ;
- taille des cibles sur écran tactile.

### Matrice à compléter

| Parcours | Clavier | Lecteur d’écran | Contraste | Mobile |
|---|---|---|---|---|
| Ouvrir Graph puis rechercher | [À TESTER] | [À TESTER] | [À TESTER] | [À TESTER] |
| Parcourir l’arbre | [À TESTER] | [À TESTER] | [À TESTER] | [À TESTER] |
| Focaliser un domaine | [À TESTER] | [À TESTER] | [À TESTER] | [À TESTER] |
| Ouvrir un nœud exact | [À TESTER] | [À TESTER] | [À TESTER] | [À TESTER] |
| Charger plus de connexions | [À TESTER] | [À TESTER] | [À TESTER] | [À TESTER] |
| Revenir au niveau précédent | [À TESTER] | [À TESTER] | [À TESTER] | [À TESTER] |
| Redimensionner les panneaux | [À TESTER] | [À TESTER] | [À TESTER] | N/A |

## Questions structurantes à trancher

| Question | Pourquoi elle change le produit | Recommandation par défaut |
|---|---|---|
| Tâche principale : architecture, dépendances ou code mort ? | Une même géométrie ne maximise pas les trois | Architecture par défaut, modes explicites pour les deux autres |
| Une surface doit-elle représenter le nombre affiché ou le nombre total ? | Sinon l’aire devient trompeuse | Aire = représenté ; total exact écrit et clairement séparé |
| Le drill-down d’un domaine doit-il devenir exhaustif ? | Définit la frontière exact/représentatif | Oui, mais paginé et à la demande |
| Hiérarchie de référence : chemin, package, imports ou appels ? | Change domaines et communautés | Chemin par défaut ; vue flux séparée |
| Quelles arêtes sont prioritaires ? | Affecte bundles, physique et lisibilité | Structure d’abord à l’overview, appels/imports au drill-down |
| Le signal de profondeur d’appel V1 doit-il revenir ? | C’est une force visuelle de la V1 | L’expérimenter en couches 2D avant de réintroduire la 3D |
| Quel budget de rendu ? | 1 000 nœuds n’a pas le même coût partout | Budget adaptatif après profilage nœuds + arêtes + DPR |
| Recherche et filtres doivent-ils se combiner ? | Évite les contradictions | Recherche exhaustive ; filtres optionnels explicitement appliqués |
| Que signifie exact pendant un réindex ? | Conditionne les curseurs et caches | Exact à une révision ; curseur expiré si elle change |
| Cible accessibilité ? | Détermine contraste, DOM alternatif et tests | WCAG 2.2 AA pour les parcours principaux |
| Qui bénéficie de l’économie de tokens ? | UI humaine et MCP modèle ne sont pas équivalents | Mesurer séparément humain, HTTP et MCP |
| Quel seuil autorise WebGL/Worker ? | Évite une complexité prématurée | Seulement après preuve de long tasks/FPS insuffisants |

## Backlog priorisé

### P0 — bloque la revendication « meilleure que V1 »

#### P0-1 — Substantiellement fermé : langage exact/représentatif

- qualifier tous les comptes de filtres, arbre, communautés et bundles ;
- préciser que le catalogue exact concerne le premier niveau seulement ;
- éviter qu’une sélection de domaine paraisse exhaustive ;
- ajouter des tests de contrat sur chaque libellé de fidélité.

Critère : aucune absence ou grandeur de la carte ne peut être interprétée comme
une vérité projet sans mention de son périmètre.

#### P0-2 — Fermé : pages exactes cohérentes à une révision

- exposer une révision stable du graphe ;
- la lier aux curseurs recherche/voisinage ;
- refuser une page issue d’un index différent avec une erreur récupérable ;
- redémarrer proprement le chargement côté hooks.

Critère : une séquence paginée dite exacte ne mélange jamais deux index.

#### P0-3 — Partiel : V2 warm mesurée, comparaison V1 restante

- remplir les tableaux backend, transport, navigateur et tâches utilisateur ;
- conserver scripts, fixture, versions et sorties brutes ;
- comparer cold et warm ;
- interdire toute affirmation « plus rapide » non reliée à ce rapport.

Critère : conclusion reproductible par un tiers sur la même révision.

#### P0-4 — Fermé : validation locale et CI de PR

- typecheck et tests ciblés backend ;
- typecheck, tests et build Graph UI ;
- build:package ;
- démarrage du paquet construit ;
- smoke API layout/search/neighborhood/scope ;
- contrôle visuel desktop, mobile et trois niveaux de zoom ;
- contrôle des logs et du CPU après refroidissement.

Critère : le paquet réellement publiable, pas seulement les sources, est validé.

#### P0-5 — Partiel : revue côte à côte, test aveugle restant

- captures comparables, même projet et même viewport ;
- scénarios chronométrés en aveugle ;
- revue utilisateur sur hiérarchie, densité, flux, lisibilité et identité ;
- correction des blocages visuels avant publication.

Critère : la V2 est préférée sur des tâches définies, pas seulement sur une
impression de modernité.

### P1 — qualité et performance nécessaires

#### P1-1 — Fermé : drill-down exact de scope

- `/api/scope` liste exactement un domaine ou dossier avec curseur opaque lié à
  `graph_revision` ;
- les nœuds avancent par clé d’identifiant et les lots d’arêtes denses restent
  bornés par des pages de continuation ;
- une arête interne appartient au lot qui introduit son extrémité d’identifiant
  maximal : aucun doublon, aucun lien pendant vers un nœud non chargé ;
- le hook abandonne les requêtes obsolètes, refuse de fusionner deux révisions
  et redémarre après `GRAPH_REVISION_MISMATCH` ;
- le frame exact remplace l’overview dans le même canvas/simulation, affiche
  `partiel exact` jusqu’à la dernière page, se recentre au changement de frame
  et permet de revenir à l’overview ;
- les appartenances domaine/dossier sont indexées une fois par révision puis
  partagées par les pages : sur le graphe courant, la page chaude passe à
  **5–13 ms** (contre 74–106 ms avant cache) ; le domaine `graph-ui` reconstruit
  exactement **1 486 nœuds / 1 846 arêtes en 22 pages**, sans doublon.

La carte globale reste bornée ; l’exhaustivité est explicite et à la demande.

#### P1-2 — Optimiser la recherche après mesure

Éviter de recalculer inutilement le total à chaque page, étudier un cache lié à
la révision et n’ajouter FTS/trigram qu’avec égalité sémantique prouvée.

#### P1-3 — Fermé : préserver les sélections exactes au refresh

Distinguer un nœud hors overview d’un nœud supprimé et tester les notifications
WebSocket pendant recherche, détail et pagination.

#### P1-4 — Fermé pour la règle actuelle : clarifier filtres et recherche

Rendre la règle visible, ajouter éventuellement les filtres au contrat serveur
et lier tout curseur aux filtres actifs.

#### P1-5 — Budget adaptatif et profil dense

Mesurer le coût par nœuds, arêtes, labels et DPR. Adapter le niveau de détail ou
le nombre de représentants sans provoquer de saut de topologie.

#### P1-6 — Partiel : parcours clavier renforcé, AA à auditer

Audit axe/contraste, tests lecteur d’écran, liste exacte alternative au canvas,
tailles minimales de cible et encodages non exclusivement colorés.

#### P1-7 — Partiel : renforcer le langage visuel

Tester :

- direction plus lisible des bundles ;
- importance des hubs sans surcharge ;
- profondeur d’appel sous forme de couches 2D ;
- légende relationnelle compacte ;
- distinction plus forte entre surface de domaine et communauté ;
- labels qui restent stables pendant le zoom.

Chaque variante doit être évaluée par tâche et non par préférence isolée.

Le mode `Stellar flow` ferme une partie supplémentaire sans créer un second
produit : il réintroduit le signal degré → spectre, encode le type par forme,
rend la direction du flux sélectionné, fait ressortir les hubs par chemins
Canvas bornés et déroule jusqu’à quatre couches de relations dirigées visibles.
La légende par type de relation, l’évaluation perceptuelle de cette profondeur
et la comparaison aveugle restent ouvertes.

#### P1-8 — Partiel : smoke HTTP/data automatisé, DOM CI restant

Le démarrage du paquet installé, le chargement HTTP des assets et les principales
APIs sont maintenant automatisés après `build:package`. Il reste à exécuter le
JavaScript dans un navigateur CI et à valider au moins une interaction DOM.

### P2 — approfondissements après preuve

- mode « architecture » et mode « dependency flow » séparés ;
- mini-carte ou overview persistant pendant le drill-down ;
- vues sauvegardées et deep links vers scope/nœud/filtres ;
- catalogue exact des communautés si son coût est acceptable ;
- export d’une vue avec légende et métadonnées de fidélité ;
- simulation dans un Worker ou OffscreenCanvas si le profil montre des long
  tasks ;
- backend WebGL uniquement si Canvas 2D ne tient pas les budgets mesurés ;
- panneau local de diagnostic performance activable en développement ;
- comparaison automatisée de captures sur fixtures déterministes.

## Facilité de mise à jour

### Ce qui est déjà favorable

- séparation claire graph-ui / v2 ;
- contrats TypeScript centralisés ;
- hooks réseau avec timeout/abort ;
- tests ciblés sur les interactions fragiles ;
- build:package utilisé aussi par prepack ;
- copie et validation des références d’assets ;
- serveur capable de résoudre les assets embarqués ou de développement ;
- lecteurs SQLite compatibles avec plusieurs formes historiques de propriétés ;
- contrats HTTP versionnés et pagination exacte liée à une révision ;
- budgets bundle déterministes via manifeste Vite ;
- smoke du tarball installé avec fixture indexée et assets servis ;
- lockfiles npm v3, plancher Node testé et migrations majeures volontairement
  séparées des patchs/minors automatisés.

### État des dépendances contrôlé sur cette révision

`npm audit` ne signale aucune vulnérabilité dans `graph-ui` ni `v2`, et les
dépendances installées respectent les plages déclarées. Les écarts restants sont
principalement des changements majeurs : Vite/plugin React, TypeScript et jsdom
côté UI ; better-sqlite3, Commander, TypeScript et Vite côté paquet V2. Ils ne
doivent pas être regroupés dans une mise à jour aveugle : jsdom relève aussi le
plancher Node selon la version ciblée, et better-sqlite3 exige une validation de
la matrice native complète.

### Ce qui manque pour dire « mise à jour facile »

- fixture de compatibilité ancienne DB → nouvelle UI ;
- test e2e navigateur des parcours Graph dans la CI ;
- gate `npm audit` et rapport périodique des majors ignorées ;
- playbooks de migration Vite/plugin React, TypeScript, jsdom et
  better-sqlite3 avec matrice Node minimale/package/Docker ;
- procédure documentée pour comparer avant/après sur le même graphe ;
- workflow de release publique avec tag exact, checksums/provenance et miroir
  de tags ; R169E/R170 restent prérequis avant toute release.

Une mise à jour est « facile » lorsqu’elle échoue tôt, explique pourquoi, garde
les anciens projets lisibles et produit un paquet vérifié sans étape manuelle
cachée.

## Définition de terminé pour ce chantier

Le Graph UI V2 peut être considéré au niveau visé lorsque :

- chaque donnée affichée est qualifiée exact/représentatif/partiel ;
- la recherche et le voisinage exacts restent cohérents pendant les refreshs ;
- le drill-down permet d’atteindre tout symbole sans charger tout le graphe ;
- les benchmarks courants démontrent les gains ou exposent clairement les
  compromis ;
- les tâches perceptuelles sont au moins aussi rapides et moins ambiguës que
  dans la V1 ;
- le canvas reste fluide puis revient à un CPU proche de l’inactif ;
- clavier, tactile et parcours DOM exact accomplissent les mêmes tâches
  essentielles ;
- les contrastes et annonces sont vérifiés ;
- typecheck, tests, build, package et smoke runtime passent ;
- le paquet publié reproduit exactement le comportement validé.

## Prochaine séquence après intégration

1. Exécuter le benchmark V1/V2 sur le même graphe : cold et warm, navigateur,
   FPS, long tasks et deuxième page de recherche/voisinage.
2. Organiser une comparaison aveugle des tâches, puis valider le parcours avec
   lecteur d’écran et les contrastes.
3. Définir et appliquer un budget adaptatif uniquement à partir des mesures
   nœuds, arêtes, labels, viewport et DPR.
4. Ajouter au gate du paquet un navigateur CI qui exécute le JavaScript et une
   interaction DOM réelle.
5. Écrire les playbooks de migration des dépendances majeures avant toute montée
   Vite/plugin React, TypeScript, jsdom ou better-sqlite3.

La conclusion démontrée à cette révision est la suivante :

> La Graph UI V2 est plus structurée, plus exacte dans ses parcours à la demande
> et mieux protégée contre les régressions de mise à jour ; son backend et son
> transport ont aussi été mesurés en régime warm. Sa suprématie globale de
> performance et d’esthétique face à la V1 reste toutefois à prouver avec le
> protocole same-graph cold/browser et une comparaison aveugle des tâches.

## Addendum — Stellar flow sans second moteur

La comparaison runtime avec la V1 a confirmé une différence précise : la V2
est plus explicable et plus exacte, mais la vue de symboles n’exposait pas aussi
vite les hubs et le sens du flux. La correction n’est pas un retour à Three.js
ou à deux implémentations concurrentes.

`Architecture` et `Stellar flow` partagent désormais strictement :

- le sous-graphe représentatif, ses métadonnées de fidélité et ses révisions ;
- les objets de nœuds d3, l’instance de simulation, le canvas et les niveaux de zoom ;
- les filtres, sélections, voisinages exacts, recherche et panneaux ;
- les cibles souris/tactiles/clavier et les annonces d’accessibilité.

La différence porte maintenant sur une politique de tâche, géométrie comprise.
Sans sélection, `Stellar flow` place les hubs de degré exact au centre d’une
constellation déterministe et conserve les communautés de répertoire sous forme
de secteurs angulaires. Avec une sélection, le symbole devient l’origine, les
distances dirigées visibles sont déroulées sur quatre couches au maximum —
entrantes à gauche, sortantes à droite — et les symboles sans relation restent
en contexte extérieur atténué. `Architecture` conserve ses ancres serveur et
ses contours domaine/communauté.

La peinture Stellar utilise toujours le degré exact entrant + sortant pour
l’échelle spectrale de référence V1. Le type reste décodable sans couleur :
cercle pour les appels/symboles usuels, losange pour classe/interface/type,
carré pour fichier/dossier/module/section. Le statut reste un contour
indépendant. Les hubs ont un halo additif groupé et les chevrons directionnels
sont limités aux arêtes visibles du nœud sélectionné.

Le choix est localement persisté et toute valeur absente/invalide revient à
`Architecture`. Un changement de vue ou de symbole focal réconfigure les forces
de l’instance existante et la réchauffe une seule fois ; les sous-ensembles de
filtre déjà connus ne la réchauffent pas. Les régressions vérifient les cibles
déterministes, les couches entrantes/sortantes, l’identité du canvas, la
persistance et le contrat couleur/forme. Le budget de 40 Kio gzip du chunk Graph
reste un gate de build.

Non-objectifs explicites : aucune profondeur 3D ou d’appel inventée — les
couches proviennent uniquement des arêtes visibles —, aucune seconde topologie,
aucun rendu 3D/WebGL, aucun shadow blur ou gradient par nœud, et aucune
affirmation de supériorité de performance V1/V2 avant le protocole same-graph
navigateur.

Validation courante : typecheck Graph UI, **22 fichiers / 159 tests**, build
frontend et `build:package` passent. Le chunk Graph applicatif mesure **39,96
Kio** selon le gate sur un plafond de 40 Kio ; le JavaScript manifeste mesure
**123,23 Kio** sur un plafond de 125 Kio.

Le contrôle à 1 280 px a également supprimé l’action `Clear selection` dupliquée
dans la barre supérieure : avec le nouveau sélecteur visuel, elle chevauchait le
HUD. L’action reste dans le panneau latéral et dans le fil d’Ariane
`Architecture`, donc la correction réduit le chrome sans retirer de parcours.
La barre reste verticale jusqu’à `xl`, et jusqu’à `2xl` lorsque le panneau de
détail réduit le canvas ; une régression DOM verrouille ces deux états.

## Addendum — passe macro-first

La première itération post-audit applique une règle plus stricte : un niveau de
zoom ne rend qu’une seule grammaire visuelle.

- domaines : noms, territoires, communautés agrégées et 28 flux dirigés au
  maximum ; aucun nœud ni arête brute ; les comptes exacts n’apparaissent que
  pour le domaine actif ;
- communautés : 28 labels au maximum et 32 flux principaux ; les relations de
  même direction sont fusionnées et colorées par leur type dominant ;
- symboles : les nœuds et arêtes locales n’apparaissent qu’à partir de 18 px
  d’espacement projeté ; les arêtes intercommunautés entrent plus tard et avec
  une opacité bornée.

Cette séparation retire les milliers de points illisibles de la vue globale et
évite de mélanger flux communautaires, arêtes brutes et labels de symboles dans
une même image. Les détails supprimés du niveau macro restent disponibles par
drill-down, recherche exacte et voisinage exact.

La régression est couverte par les tests Canvas : absence de nœuds et d’arêtes
brutes aux niveaux macro, apparition au niveau symboles, agrégation d’une paire
dirigée multi-relation et affichage des comptes exacts uniquement à la demande.
La validation locale passe 17 fichiers et 117 tests frontend. Le paquet complet
respecte les budgets gzip (Graph 39,25 kB ; bundle principal 72,56 kB). Sur sept
exécutions warm du graphe courant (9 764 nœuds, échantillon de 1 000), le layout
gzip mesure 56 759 octets avec un p50 de 108,884 ms ; la recherche exacte a un
p50 de 19,621 ms et le voisinage exact de 1,08 ms. Ces chiffres valident cette
révision, mais ne remplacent pas le protocole comparatif V1/V2 same-graph.

## Addendum — Stellar Flow Lens sémantique (2026-07-17)

Le contrôle réel du flux sélectionné a isolé quatre ambiguïtés restantes : les
liens multi-hop perdaient leur type dans le fond gris, la profondeur n'était pas
lisible sans reconstruire mentalement le chemin, tous les labels partaient vers
la droite, et un focus à fort fan-out pouvait dériver loin de l'origine sous la
force de ses propres liens.

La correction reste strictement bornée et ne crée aucun renderer supplémentaire :

- le focus actif est fixé à `(0,0)` dans l'instance d3 existante puis libéré dès
  que la sélection ou le mode change ; le glisser souris/tactile restaure aussi
  cette origine à la fin du geste ;
- une arête n'est promue comme flux que si elle avance réellement d'une couche
  entrante ou sortante. Les liens directs dominent ; les profondeurs 2–4 gardent
  la même couleur et le même motif à une intensité inférieure ;
- `calls`, `imports`, `contains`, `data` et `other` possèdent chacun un motif de
  trait et un glyphe distincts en plus de leur couleur. La légende DOM ne liste
  que les groupes incidents au focus avec leur nombre visible ;
- les rails `IN/OUT/BOTH` indiquent profondeur et effectif. Les chemins de
  fichiers regroupent les voisins dans des lanes stables ; seuls six groupes
  répétés des deux premières couches peuvent recevoir un label de module ;
- les labels entrants s'ouvrent vers la gauche et les sortants vers la droite.
  Deux alternatives verticales déterministes sont essayées avant omission, et
  les boîtes des nœuds du flux deviennent des obstacles de collision ;
- le guide sélectionné remonte au-dessus du fil d'Ariane pour ne plus partager
  le même espace bas du canvas.

Les nouveaux calculs coûteux — classification des arêtes de flux et résumés de
lanes — sont exécutés au changement de focus, pas à chaque frame. Le rendu reste
regroupé en cinq familles de relations ; les liens de transit ajoutent au plus
cinq batches Canvas bornés. La simulation, le canvas, les objets de nœuds, les
filtres et les données exactes restent partagés avec `Architecture`.

Les régressions couvrent la classification insensible à la casse, le décodage
hors couleur, la légende limitée au focus, les profondeurs réelles, le rejet des
cross-links, le regroupement module, les ancres de labels et le verrouillage puis
la libération de l'origine. La validation courante passe **22 fichiers / 159
tests**, le typecheck, le build frontend et le paquet complet. Les gates restent
respectés : Graph **39,96 / 40 Kio**, JavaScript manifeste **123,23 / 125 Kio**.

## Addendum — Stellar Focus Composer responsive (2026-07-17)

Le contrôle du paquet fusionné à 1 280 px a exposé le problème suivant : ouvrir
le détail réduisait correctement le canvas, mais la caméra restait centrée sur
`(0,0)` à un zoom quasi fixe. Les couches trois et quatre, les labels sortants et
les contrôles occupaient alors la même largeur ; les entrées pouvaient être
coupées à gauche. Ajuster uniquement les couleurs ou la répulsion n'aurait pas
corrigé cette cause géométrique.

Le Focus Composer introduit un contrat de caméra testable et sans second moteur :

- seuls le focus et ses couches dirigées définissent les bornes ; les nœuds de
  contexte restent visibles mais ne peuvent plus réduire le voisinage utile ;
- les zones du HUD, de la barre d'actions, du guide et du fil d'Ariane sont
  réservées en pixels écran, indépendamment du DPR et du zoom monde ;
- un redimensionnement de viewport ou de panneau recompose une caméra encore
  intacte sans reconstruire les nœuds, relancer la simulation ou perdre un pan
  volontaire de l'utilisateur ; `Fit`, `Reset` et la touche `0` partagent ce
  même contrat ;
- la première couche garde son espacement complet. Les profondeurs deux à quatre
  progressent toujours vers l'extérieur avec une distance sous-linéaire, ce qui
  garde les rails ordonnés sans sacrifier la taille perceptuelle du voisinage ;
- les labels exacts/directs sont prioritaires, le budget dépend de la surface
  écran utile et toute boîte qui croiserait les bords ou le chrome persistant est
  omise avant peinture ;
- le tri des candidats de labels est exécuté au changement de frame sémantique,
  pas pendant chaque tick/paint Canvas.

Les régressions couvrent les viewports desktop étroits et larges, les flux
asymétriques, les quatre profondeurs, le rejet des labels hors zone sûre, le
budget d'attention et la progression distante monotone. La validation courante
passe **22 fichiers / 159 tests**, le typecheck, le build frontend et le paquet
complet. Les budgets frontend mesurés sont Graph **39,96 / 40 Kio** et
JavaScript manifeste **123,23 / 125 Kio**.
