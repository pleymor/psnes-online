# Passe d'architecture : maintenabilité

**Date :** 2026-08-26
**Statut :** design validé, plan d'implémentation à écrire

## Objectif

Réduire le coût de modification du code sans changer ce que voit le joueur.
Trois symptômes mesurés : environ 1 780 lignes injoignables depuis les routes,
huit fichiers au-dessus de 1 000 lignes qui portent chacun six à huit
responsabilités, et une documentation d'architecture qui décrit un mode de jeu
qui n'est plus le mode par défaut.

Le périmètre est le découpage, le code mort, les motifs de conception et la
documentation. Aucune fonctionnalité n'est ajoutée ni retirée.

## Contraintes

**Les modes STREAMING et DUAL restent en place et ne sont pas refactorés.**
Décision du propriétaire. `P2PRoom.svelte`, `netplay/`, `multiplayer/`,
`webrtc/`, `ClientEmulator.svelte` et `DualClientEmulator.svelte` sont hors
périmètre, à une exception documentée au chantier 1.

**Aucun changement de comportement observable**, à cette même exception près.
Le critère d'acceptation de chaque chantier est que les suites existantes
passent sans modification de leurs assertions.

**Svelte 4 dérive ses dépendances réactives des identifiants écrits dans
l'instruction elle-même.** Un `$:` ou une expression de template qui appelle une
*déclaration de fonction* dont le corps lit de l'état réactif compile en
initialisation unique, sans erreur ni avertissement. Ce piège a mordu quatre
fois sur ce projet. Il gouverne la conception du chantier 3 et impose une
vérification par compilation, la lecture du diff ne pouvant pas trancher.

**Le filet de sécurité.** `core/test/netcode.test.ts` contient 57 tests qui
passent tous par l'API publique de `NetplaySession` — ils couvrent nommément le
calibrage du délai, la gigue, la tension, l'epoch et la resynchronisation. C'est
ce qui rend le chantier 2 raisonnable. Les tests ne sont pas modifiés : la
surface publique de `session.ts` est préservée à l'identique, ré-exports compris.

## Ordre d'exécution

`1 → 2 → 4 → 3 → 5 → 6`

Le code mort d'abord, parce qu'il ne sert à rien de refactorer ce qu'on
s'apprête à supprimer. Puis les deux blocs isolés et bien testés (`session.ts`,
backend). Puis les composants, les plus risqués, une fois que les utilitaires
partagés dont ils dépendent existent. Puis la page room. Les docs en dernier,
quand la forme finale est connue.

Vérification à chaque palier : `npm run test:all`, `tsc` côté backend,
`svelte-check` côté frontend. Le chantier 3 ajoute la passe de compilation
Svelte décrite plus bas.

---

## Chantier 1 — Code mort et utilitaires dupliqués

### Suppressions

Dix fichiers injoignables depuis les routes. Établi par parcours du graphe
d'imports depuis `src/routes/**` et `service-worker.ts`, puis confirmé fichier
par fichier par recherche du chemin d'import exact.

| Fichier | LOC |
|---|---|
| `frontend/src/lib/components/GameCanvas.svelte` | 626 |
| `frontend/src/lib/emulator/performance-monitor.ts` | 284 |
| `frontend/src/lib/emulator/network-detector.ts` | 206 |
| `frontend/src/lib/emulator/input-buffer.ts` | 130 |
| `frontend/src/lib/emulator/input-predictor.ts` | 111 |
| `frontend/src/lib/emulator/audio-capture.ts` | 104 |
| `frontend/src/lib/emulator/sync-manager.ts` | 100 |
| `frontend/src/lib/config/socketEvents.ts` | 91 |
| `frontend/src/lib/services/latency.ts` | 63 |
| `frontend/src/lib/config/keyConfig.ts` | 62 |

Deux pièges relevés pendant l'analyse et écartés :
`frontend/src/lib/polyfills.ts` est vivant (`import '$lib/polyfills'` sans
clause `from`, invisible à un détecteur naïf) et `backend/src/db/migrate-cli.ts`
est vivant (point d'entrée du conteneur de migration, `docker-compose.yml:28`).

`emulator/input-buffer.ts` est distinct de `netplay/input-buffer.ts`, qui reste
en place : seul le second est atteint, via `netplay/index.ts`.

### Base64

`frontend/src/lib/saves/base64.ts` expose `toBase64`, testé, avec un en-tête qui
documente le débordement de pile que la fonction évite : `String.fromCharCode`
prend un argument par octet et casse aux alentours de 100 000, or un savestate
dépasse 800 Ko.

Quatre autres sites réécrivent cet encodage à la main et il n'existe aucun
`fromBase64`, donc quatre sites réécrivent aussi le décodage.

Actions :
- ajouter `fromBase64(text: string): Uint8Array` à `saves/base64.ts`, en
  conservant la propriété qui justifie l'existence du module — aucun import,
  pour rester atteignable depuis `core/test` qui tourne sous node nu et ne
  résout pas l'alias `$lib` ;
- étendre `core/test/quick-save.test.ts` avec un aller-retour sur un tampon de
  plus de 100 000 octets, la taille qui casse les versions naïves ;
- remplacer les sites : `LockstepRoom.svelte:944` et `:913`, `:959` ;
  `SoloRoom.svelte:446`, `:342`, `:392`.

**Exception au périmètre, décidée.** `P2PRoom.svelte:280` fait
`String.fromCharCode(...Array.from(uint8Array))` sur le SRAM entier : c'est
exactement le plantage que `toBase64` existe pour empêcher, et
`SoloRoom.svelte:446` a la même faute sous une autre forme (boucle octet par
octet, qui ne plante pas mais construit une chaîne de 800 Ko caractère par
caractère).

Les deux sites passent à `toBase64`, y compris celui de `P2PRoom` qui est par
ailleurs hors périmètre. C'est le seul changement de comportement de toute la
passe : il supprime un plantage, il n'en introduit pas, et laisser sciemment en
place un défaut connu dans le fichier qu'on a sous les yeux coûte plus cher que
la ligne qu'il faut pour le corriger.

### Vérification

`npm run test:all`, `svelte-check`, `npm run build`. Une suppression qui casse
la compilation est une suppression fautive : le graphe est revérifié plutôt que
le fichier restauré.

---

## Chantier 2 — `znet/session.ts` : 1 517 → environ 900 lignes

`NetplaySession` porte une cinquantaine de champs privés et mêle six sujets. Le
découpage extrait ce qui est décidable sans effet de bord, et laisse dans la
classe ce qui touche au transport et à la machine à états.

### Modules extraits

**`znet/link-metrics.ts` — `LinkMetrics`** (~200 lignes)

Ce que le lien fait, mesuré. Aller-retour et pings en attente (`pendingPings`,
`nextPingId`, `_rtt`), gigue lissée RFC 3550 (`sampleJitter`, `_jitter`,
`lastPadArrival`), anneau de frames tardives locales (`noteFrameTiming`,
`lateRing`, `lateAt`, `lateCount`), tension rapportée par le pair
(`_peerStrain`), compteurs de paquets.

Ne décide rien. Reçoit un horodatage en paramètre plutôt que de lire l'horloge,
comme le fait déjà la session — c'est ce qui permet aux tests de piloter des
sessions entières sur une horloge virtuelle.

**`znet/delay-control.ts` — `DelayController`** (~250 lignes)

La politique de délai d'entrée, et rien d'autre. Reprend `suggestInputDelay`,
la rafale de calibrage du handshake (`sizingSince`, `sizingSamples`,
`sizingPings`), la fenêtre glissante de secondes tendues (l'anneau
`strainedRing` et sa comptabilité, aujourd'hui les soixante premières lignes de
`notePeerStrain`), le drapeau auto/épinglé et les bornes.

Interface : `observePeerStrain(strain, nowMs)` renvoie
`{ delta: -1 | 0 | 1, reason: string }`. **Le contrôleur décide, il n'applique
pas.** C'est la frontière que l'analyse a corrigée : `setDelay` n'est pas de la
politique, il rebouche le trou laissé dans la timeline de pads par une
augmentation et réémet la plage concernée. Cette partie reste dans `session.ts`,
où elle a accès au transport.

L'hystérésis asymétrique — dix secondes tendues pour prendre une frame, trente
secondes propres pour en rendre une — devient testable directement, alors
qu'elle n'est aujourd'hui atteignable qu'en pilotant une session complète.

**`znet/pad-timeline.ts` — `PadTimeline`** (~120 lignes)

Les deux `Map` de pads et les deux `Map` de CRC, avec `hasAllPads`,
`pruneHistory`, `primeStartupPads`, les requêtes de plage utilisées par
`sendPadRange`, et le rebouchage de trou appelé par `setDelay`.

### Ce qui reste dans `session.ts`

Machine à états, transport, handshake, epoch et resynchronisation, `tick()`,
et les handlers de messages (`handleMessage`, `onHello`, `onPads`, `onCrc`,
`onStateChunk`, `onStateAck`).

Les handlers ne sont **pas** extraits, délibérément : ils mutent une quinzaine
de champs privés, et les sortir obligerait à élargir la surface de la classe
pour leur donner accès — ce qui rendrait le fichier plus court sans le rendre
plus simple. La cible réaliste est environ 900 lignes, pas 400. Ce choix est
consigné dans l'en-tête du fichier pour que la question ne soit pas rouverte
sans raison.

### Surface publique

Inchangée. `session.ts` continue d'exporter `NetplaySession`,
`suggestInputDelay`, `NetplayCore`, `SessionEvent`, `SessionOptions`,
`SessionState`, `SessionStats`, `TickResult`, `TickSource` — au besoin par
ré-export depuis les nouveaux modules. `core/test/netcode.test.ts`,
`core/test/harness.ts` et `znet/index.ts` ne sont pas modifiés.

### Correction de documentation

L'en-tête de `notePeerStrain` affirme « One-way on purpose — it only ever
raises. Lowering is what two earlier attempts got wrong ». Le corps redescend,
dans la branche `strainedCount === 0`, et son commentaire interne explique
longuement pourquoi. Le commentaire d'en-tête est un vestige antérieur à
l'ajout de la descente. Il est réécrit en même temps que la logique déménage
vers `DelayController`, en conservant les deux raisonnements — pourquoi ça
monte sur le signal du pair, pourquoi ça redescend seulement sur une fenêtre
entièrement propre.

### Tests ajoutés

`core/test/delay-control.test.ts` et `core/test/link-metrics.test.ts`, ajoutés
au script `test:netplay`. Ils couvrent en direct ce que les tests de session
n'atteignent qu'indirectement : la fenêtre de tension à cheval sur une coupure
de plusieurs secondes, le lissage de gigue face à un paquet réordonné, le rejet
de l'échantillon de préchauffage par l'estimateur.

### Vérification

`npm run test:netplay` et `npm run test:core`. Les 57 tests existants sont le
critère principal ; un test qu'il faut modifier pour le faire passer signale un
changement de comportement, donc une erreur d'extraction.

---

## Chantier 3 — Composants Solo et Lockstep

`LockstepRoom.svelte` fait 1 772 lignes dont 1 270 de `<script>`.
`SoloRoom.svelte` fait 1 106 lignes. Le bloc renderer et shader est
**fonctionnellement identique** dans les deux : un diff des deux régions ne
montre que des différences de commentaires.

### Ce qui est réellement partagé

Vérifié région par région. Toutes les duplications ne se valent pas :

- **Renderer et shader** — `useCanvasRenderer`, `applyShader`,
  `onDisplayChange`, `checkRendererHealth` : identiques. Environ 100 lignes de
  chaque côté.
- **SRAM** — même intention, deux implémentations divergentes, dont une fautive.
  Voir chantier 1.
- **Sources d'entrée** — `applySources` : même corps, Lockstep pilote un seul
  collecteur, Solo en pilote deux.
- **Plein écran et menu pause** — **pas** identiques, et c'est intentionnel.
  Solo arrête vraiment son governor en pause ; Lockstep ne peut pas, arrêter son
  horloge cesserait d'émettre les pads et figerait le pair. Lockstep porte en
  plus le masquage automatique de la barre d'outils et le traitement d'Échap en
  sortie de plein écran. Ces différences sont conservées comme telles.

### Modules créés

| Module | Rôle |
|---|---|
| `lib/rooms/renderer-surface.ts` | cycle de vie 2D/WebGL, chargement de preset, repli sur échec, contrôle de santé |
| `lib/rooms/sram.ts` | lecture et application du SRAM, au-dessus de `saves/base64` |
| `lib/rooms/input-sources.ts` | résolution des affectations de périphériques vers les collecteurs |
| `lib/rooms/fullscreen.ts` | bascule plein écran, avec la distinction volontaire/Échap en option |
| `lib/rooms/chrome-autohide.ts` | minuterie de la barre d'outils (Lockstep seul, mais 60 lignes de tenue de minuteurs qui n'ont rien à faire dans un composant) |

`fullscreen.ts` prend le comportement de Lockstep en paramètre plutôt qu'en
fourche : Solo passe l'option à `false` et n'hérite d'aucune branche morte.

**Un `boot.ts` partagé était prévu ici et a été abandonné** à l'écriture du
plan, après lecture des deux `boot()`. La part réellement commune aux deux
`obtainRom` fait dix lignes, et `resolveQuietly` est déjà le helper que les deux
appellent ; passé ces dix lignes ils divergent entièrement, le client lockstep
demandant la ROM à l'hôte avant de la demander au joueur. Le reste de `boot()`
séquence douze variables réactives du composant, et l'extraire imposerait de
passer douze setters ou de sortir l'état réactif — c'est-à-dire exactement le
piège Svelte 4 que cette passe surveille.

Cible : `LockstepRoom` vers environ 1 000 lignes, `SoloRoom` vers environ 680.

### Règle de conception imposée par Svelte 4

Toute valeur réactive consommée par un module extrait **est passée en paramètre
explicite**, de sorte que son identifiant apparaisse sur le site d'appel. Les
fonctions extraites ne lisent jamais d'état réactif depuis leur corps.

La reformulation évidente ne suffit pas : `$: x = f()` ne fait que déplacer
l'initialisation unique. Une expression de fonction affectée dans un `$:` est
tracée correctement ; une déclaration de fonction appelée depuis un `$:` ne
l'est pas.

### Vérification

En plus des suites habituelles, une passe obligatoire : compiler chaque
composant modifié avec le svelte de l'espace de travail vers un répertoire
temporaire, et vérifier que chaque prop concernée apparaît dans le bloc
`*_changes` généré sous une garde `dirty` non vide. Une prop présente dans
l'objet `*_props` d'initialisation mais absente de `*_changes` est gelée par
construction.

Cette vérification n'est pas un supplément de prudence : ce mode de défaillance
est silencieux à la compilation comme à l'exécution, et il a échappé quatre fois
à une relecture, dont une fois à une relecture qui cherchait explicitement ce
défaut.

Suites concernées : `npm run test:ui`, `npm run test:core`, plus les
spécifications Playwright `e2e/resume-from-save.spec.ts` et
`e2e/local-roms.spec.ts`.

---

## Chantier 4 — Backend

### `websocket/room-handlers.ts` : 1 054 → environ 700 lignes

Le fichier porte deux sujets. Le cycle de vie des rooms (`room:*`, l'adhésion,
la présence, la diffusion) et les invitations de lobby (`lobby:*`).

`websocket/invitation-handlers.ts` prend `lobby:invite`, `lobby:cancel`,
`lobby:accept`, `lobby:decline`, plus `InvitationView`, `toInvitationView`,
`pendingInvitationsFor`, `findOwnInvitation` et `INVITATION_TTL_MS` — environ
360 lignes.

La dépendance est à sens unique : `invitation-handlers` importe `joinRoom` et
`broadcastRoomUpdate` de `room-handlers`, jamais l'inverse. Pas de cycle.
`websocket/index.ts` enregistre les deux.

### `index.ts` : 353 → environ 50 lignes

Le point d'entrée mêle la validation des secrets, le câblage Express, les
tâches de fond et l'arrêt gracieux.

- `bootstrap/env-guard.ts` — refus de démarrer en production sur un secret
  absent, trop court ou resté sur un gabarit, et sur `AUTH_MODE=dev`
- `bootstrap/app.ts` — Express, helmet, compression, CORS, session, passport,
  routeurs, gestionnaire d'erreurs terminal
- `bootstrap/jobs.ts` — balayage des invitations expirées, restauration et
  balayage des rooms abandonnées, instantanés périodiques, rafraîchissement des
  métadonnées
- `bootstrap/shutdown.ts` — SIGTERM et SIGINT, purge des rooms, fermeture Redis

`index.ts` devient une racine de composition asynchrone.

**Ordonnancements porteurs, à préserver explicitement.** Ils sont commentés dans
le code actuel et se perdraient dans un déplacement mécanique :

1. `restoreRooms` doit être terminé **avant** `httpServer.listen`, pour que le
   premier client qui se reconnecte trouve sa room plutôt que de courir contre
   la restauration.
2. `io.engine.use(sessionMiddleware)` vient après la construction du middleware
   de session, et les trois `io.engine.use` gardent leur ordre.
3. `app.use(errorHandler)` reste après toutes les routes.
4. Le balayage des rooms abandonnées tourne une fois à la restauration, avant la
   minuterie horaire.

### Vérification

`npm run test:backend` (26 fichiers), `tsc`, et un démarrage de conteneur pour
confirmer que l'ordre d'amorçage tient hors des tests.

---

## Chantier 5 — Page room

`routes/room/[id]/+page.svelte` fait 1 238 lignes dont 719 de `<script>`, qui
mêlent la souscription aux événements socket, l'état de la room, la résolution
du mode d'émulation, et la présentation du lobby.

`lib/rooms/room-session.ts` prend le câblage socket et l'état : abonnement et
désabonnement, `handleRoomUpdated`, `handleSocketError`, `handleReconnect`,
`rebuildRoom`, et les dérivés qui n'ont rien de visuel (`isRoomCreator`,
`isRoomHost`, `isSinglePlayer`, `effectiveEmulationMode`, `modeCanResume`).

La page garde la présentation du lobby, le choix de sauvegarde et le montage du
composant de room. Cible : environ 350 lignes de script.

Les dérivés déplacés sont exposés en tant que valeurs, jamais en tant que
fonctions appelées depuis le template — même règle qu'au chantier 3, même
vérification par compilation.

`routes/+page.svelte` (218 lignes de script) est plus petit et n'est pas traité
dans cette passe. Consigné comme suite possible, pas comme dette bloquante.

---

## Chantier 6 — Documentation

### `ARCHITECTURE.md`

462 lignes qui décrivent le streaming P2P — le rôle hôte/invité, la capture de
canvas, SimplePeer, le canal de données. Le mot « lockstep » n'y apparaît pas
une seule fois, alors que c'est le mode par défaut d'une room depuis
`websocket/room-handlers.ts:191` et le seul activement développé. Un lecteur qui
part de ce document se construit un modèle faux du produit.

Réécriture autour des modes réellement livrés, lockstep en tête, avec pour
chacun le composant qui l'implémente et le module qui porte sa logique. Ajout
d'une carte des répertoires reflétant le découpage issu de cette passe.
`LOCKSTEP_NETPLAY.md` reste le document de référence du netcode ; `ARCHITECTURE.md`
y renvoie plutôt que de le paraphraser.

### Archivage

Dix fichiers `.md` à la racine, treize dans `docs/`, dont la plupart sont des
instantanés de travaux terminés : ils décrivent un état passé au présent, ce qui
est la forme la plus coûteuse de documentation périmée.

Déplacés vers `docs/history/` : `LATENCY_FIX_SUMMARY.md`,
`LATENCY_OPTIMIZATION.md`, `CHANGELOG_DUAL_MODE.md`, `TEST_DUAL_MODE.md`,
`ROLLBACK_NETCODE_PLAN.md`, `DOCKER_COMPOSE_UPDATE.md`,
`docs/DUAL_EMULATION_MODE_PLAN.md`, `docs/DUAL_EMULATION_MODE.md`,
`docs/DUAL_MODE_QUICK_START.md`, `docs/DUAL_MODE_SUMMARY.md`,
`docs/DUAL_MODE_IMPLEMENTATION_PROGRESS.md`, `docs/DEPLOYMENT_SUMMARY.md`,
`docs/COMMIT_MESSAGE.md`.

`docs/history/README.md` d'une ligne : ce sont des instantanés datés, conservés
pour le raisonnement qu'ils contiennent, et non une description de l'état
actuel.

La racine garde `README.md`, `ARCHITECTURE.md`, `LOCKSTEP_NETPLAY.md`,
`BLOG.md`.

Ne bougent pas non plus : `docs/QUICKSTART.md`, `docs/GOOGLE_OAUTH_SETUP.md`,
`docs/GITHUB_ACTIONS.md`, `docs/ROM_SYNC_FEATURE.md`, `docs/SPEED_CONTROLS.md`,
`docs/P2P_ARCHITECTURE.md`. Ce sont des documents de référence sur des sujets
toujours en place, pas des comptes rendus de travaux terminés — le critère du
déplacement est la nature du document, pas sa date.

### En-têtes de modules

Les modules créés aux chantiers 2 à 4 reçoivent un en-tête dans le registre déjà
pratiqué ici : ce que le module décide, ce qu'il ne décide pas, et la raison
d'être des choix non évidents. Ce registre est une force du dépôt, pas une
convention à inventer — les nouveaux fichiers s'y conforment.

---

## Ce que cette passe ne fait pas

- Elle ne touche pas aux modes STREAMING et DUAL, à l'exception de la ligne
  base64 du chantier 1.
- Elle ne découpe pas `netplay/simple-sync-manager.ts` (1 254 lignes),
  `P2PRoom.svelte` (1 427) ni `ClientEmulator.svelte` (1 137), qui appartiennent
  à ces modes.
- Elle n'extrait pas les handlers de messages de `session.ts`, pour la raison
  donnée au chantier 2.
- Elle ne traite pas `routes/+page.svelte`.
- Elle n'ajoute ni linter ni règle de taille de fichier. Un outil qui échoue sur
  du code que cette passe laisse en place serait ignoré dès le premier jour.

## Critères d'acceptation

1. `npm run test:all` passe, sans modification des assertions existantes.
2. `tsc` (backend) et `svelte-check` (frontend) sans nouvelle erreur.
3. `npm run build` réussit.
4. La passe de compilation Svelte ne trouve aucune prop gelée parmi celles
   touchées par les chantiers 3 et 5. Elle est aussi exécutée sur
   `GameDetailsModal.formatDate`, instance préexistante connue, pour confirmer
   que l'instrument détecte bien ce qu'il cherche.
5. Aucun fichier source applicatif au-dessus de 1 100 lignes hors des modes
   STREAMING et DUAL, et chacun des cinq fichiers visés a perdu au moins un
   tiers de sa taille. Le seuil est à 1 100 et non à 1 000 parce que
   `LockstepRoom` vise environ 1 000 une fois `boot.ts` abandonné : annoncer
   1 000 tout rond serait se donner une marge que la découpe réelle n'a pas.
   Les fichiers de test ne sont pas concernés : `core/test/netcode.test.ts`
   fait 1 559 lignes et reste tel quel.
6. `ARCHITECTURE.md` décrit le mode par défaut du produit.
7. Une session lockstep à deux joueurs démarre, tient, et survit à une
   sauvegarde puis une reprise — vérifié dans l'application, pas seulement en
   test.
