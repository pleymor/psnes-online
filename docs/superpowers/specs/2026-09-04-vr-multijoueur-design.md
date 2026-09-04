# Multijoueur en VR — écran de lancement et moteur lockstep

**Statut :** validé section par section le 2026-09-04.
**Suite de :** `2026-09-02-vr-meta-quest-design.md`, qui avait mis le multi hors
périmètre — « solo d'abord ».

## Le besoin, dans les mots du demandeur

> Si je suis dans un groupe et que je lance un jeu depuis mon espace VR, il faut
> ouvrir la room comme en non-VR, pour moi et mon ami (pas forcément en VR pour
> mon ami), pour choisir la manette, la sauvegarde et lancer le jeu à deux.

Puis, sur la surface à utiliser :

> On peut utiliser l'écran incurvé pour afficher les options de lancement de
> jeu, puisqu'aucun jeu n'est encore lancé.

---

## 1. Ce qui existe déjà et ne bouge pas

Ces faits ont été vérifiés dans le code avant toute décision. Ils réduisent le
projet de moitié et **le serveur n'a besoin d'aucune modification.**

**Choisir le jeu est ce qui ouvre le salon.** `room:choose-game` appelle
`openRoomForMembers` (`backend/src/websocket/room-handlers.ts:237`), qui envoie
`room:opened` à chaque membre. Le handler de `frontend/src/routes/+layout.svelte`
les navigue vers la page du salon. **L'ami est donc amené dans le salon sans une
ligne nouvelle.**

**Et le joueur en VR ne l'est pas.** Le même handler porte
`if (get(vrActive)) return;`, écrit pendant le travail solo pour éviter qu'un
joueur casqué soit navigué par le choix de son partenaire — ce qui monterait un
second émulateur sous une session vivante. Cette garde devient le mécanisme.

**`gameClick` décide déjà.** `frontend/src/lib/rooms/game-click.ts` est une
fonction pure : pas de salon ou moins de deux joueurs → `launch-solo` ; salon
qui joue → `blocked` ; groupe de deux → `choose-for-group`. `VrShell` l'ignore
aujourd'hui et lance toujours en solo.

**N'importe quel membre peut démarrer.** `game:start`
(`backend/src/websocket/game-handlers.ts:24`) exige d'être membre, un jeu choisi,
et au moins un joueur assis et prêt. Ce n'est pas réservé au créateur.

**Choisir un port déclare prêt.** `room:selectPort` fait
`player.port = data.port; player.isReady = true;`. Un seul emit suffit donc pour
s'asseoir.

**Le cœur netplay est déjà sans timer.** `frontend/src/lib/znet/session.ts` porte
le lockstep complet et son en-tête l'énonce : *« The engine owns no timers.
Everything happens inside `tick()` »*. C'est la forme `TickSource` que
`SoloSession` a — donc `FrameGovernor` le pilote, et la pompe de frames VR
(`vr/frame-pump.ts`) le nourrit exactement comme le solo, via l'option
`GovernorOptions.schedule` déjà ajoutée.

**Et son entrée locale a la bonne forme.** `readLocalInput` du netplay rend **un
seul** masque — celui du joueur local, l'autre arrivant par le transport. C'est
exactement ce que `readVrPad` produit. Aucune adaptation. (Le solo voulait
`{pad1, pad2}`, d'où le `pad2: 0` codé en dur dans `VrShell`.)

---

## 2. Décisions

### D1 — L'écran incurvé devient la surface de lancement, pour **tous** les lancements

Canvas quand aucun jeu ne tourne, `DataTexture` quand un jeu tourne.

**Pourquoi l'écran et pas un lutrin :** c'est la seule surface droit devant le
joueur. Les lutrins sont à ±60°, l'écartement qui a fait manquer un panneau
entier lors du premier essai matériel. Un vestiaire là ne demande aucun mouvement
de tête, aucune géométrie nouvelle, et aucune des constantes de `vr/layout.ts`
qui restent à régler dans un casque.

**Pourquoi aussi en solo :** il manque au solo VR la reprise d'une sauvegarde. Le
chemin plat offre `room:choose-save` ; en VR seule la pile de la cartouche est
chargée. Un jeu commencé sur PC est aujourd'hui irreprenable dans le casque. Un
écran de lancement unique comble ce trou et évite deux comportements pour le même
geste.

**Coût technique :** `visibleU(width, stride)` rend `min(width/stride, 1)`
(`vr/screen-geometry.ts:48`), donc passer `stride = width` reconstruit la
géométrie sur l'espace uv complet sans toucher à `rebuild()`. Le motif canvas +
régions + test de collision par uv existe déjà dans `vr/panel-mesh.ts` et le
`hit()` de `vr/panel.ts`.

### D2 — `aimedAt()` doit raycaster l'écran, et cesser de s'éteindre

Aujourd'hui `aimedAt()` (`vr/scene.ts`) rend `null` dès que `panelGroup.visible`
est faux, et ne raycaste que les panneaux.

**L'exigence, précisément :** le maillage de l'écran rejoint l'ensemble raycasté
tant qu'il est en mode canvas, et la porte devient « aucune cible pendant qu'un
jeu tourne » au lieu de « aucune cible quand les panneaux sont masqués ». La
règle d'origine existait pour que la gâchette ne serve pas à la fois de pointeur
et de bouton SNES ; elle reste tenue, puisque l'écran cesse d'être une cible dès
que la partie démarre.

**C'est nommé comme un risque, pas comme un détail.** Les trois bugs de la
semaine du 2026-09-03 avaient tous cette forme : une branche de sortie oubliée
dans un composant sans harnais de test.

### D3 — La liste des sauvegardes est affichée mais inerte quand le salon n'est pas le tien

Avec une ligne qui dit pourquoi.

`room:choose-save` est réservé au créateur du salon
(`backend/src/websocket/room-handlers.ts:383`) et ne peut plus changer une fois
la partie lancée. La règle est **délibérée** : le commit qui l'a introduite
(`a311107`, 2026-08-24) l'énonce —

> Creator-only, like the latency mode: where the game starts is not a private
> preference.

— avec sa raison technique : en lockstep les deux machines démarrent du même état
ou divergent à la première frame, et un invité mérite de voir ce qu'il rejoint
plutôt que de le découvrir.

En solo la question ne se pose pas : le salon est créé au lancement, donc le
joueur en est toujours le créateur.

**Sans ce traitement**, le serveur répondrait un `error` que rien n'affiche dans
le casque, et la sauvegarde ne s'appliquerait pas sans explication.

### D4 — Les sauvegardes se cherchent par CRC32, et leurs résumés viennent du store

Deux pièges que le même commit documente.

**Par CRC32, pas par `gameId` :** chaque joueur a sa propre ligne `Game` pour un
même dump. Si c'est l'ami qui a choisi le jeu, le salon porte *son* id, et le
chercher dans sa propre bibliothèque ne trouve rien.

**Résumés depuis le store `games`, jamais l'API :** `/api/games/:id/saves`
téléchargerait les savestates eux-mêmes, environ un mégaoctet chacun, pour
dessiner des vignettes.

### D5 — La sauvegarde choisie s'applique une fois, jamais réactivement

`SoloRoom` émet `game:load { roomId, saveId }`, le serveur répond avec l'état, et
`core.loadState(bytes)` l'applique — une seule fois, après le boot, et le
commentaire du chemin plat dit que c'est le seul ordre qui marche.

Le même commit précise pourquoi ce n'est pas réactif : les composants
d'émulation annulent leur copie après usage pour qu'une reconnexion ne rembobine
pas la partie, et une valeur réactive la repousserait au prochain
`room:updated`.

**Deux chemins pour la choisir, et ne pas les confondre.** En solo, `VrShell`
émet `game:load` directement après le boot : personne d'autre n'a besoin de voir
ce choix, et rien n'est à mettre en scène. En groupe, la sauvegarde doit être
*mise en scène* par `room:choose-save` pour que l'ami la voie avant de rejoindre
— c'est la raison invoquée par le commit `a311107` — puis le salon la porte dans
`resumeSaveId` et le moteur la résout une fois au démarrage.

**En lockstep, seul l'hôte agit sur `game:loaded`** : il adopte l'état et
réamorce la session, le client le reçoit comme n'importe quelle resynchronisation.
Appliquer des deux côtés indépendamment mettrait les deux machines sur deux
états qui ont seulement démarré des mêmes octets.

### D6 — Lockstep, et lui seul

Des trois modes (`lockstep`, `streaming`, `dual`), seul lockstep est visé.

**C'est le seul qui ne désynchronise pas**, et son défaut annoncé — *« l'image
attend quand le réseau attend »* — serait normalement disqualifiant dans un
casque, où une image qui gèle donne la nausée. **L'architecture VR l'isole :**
`renderer.render` tourne à chaque frame XR quoi qu'il arrive, et seul l'émulateur
s'arrête. Un hoquet réseau gèle donc la télé et laisse la pièce parfaitement
stable. Le suivi de tête ne stalle jamais.

`P2PRoom` n'a de toute façon aucun écouteur `game:loaded` : charger un savestate
n'existe pas dans les modes streaming et dual.

### D7 — Un jeu absent de l'appareil est refusé, pas transféré

Si l'ami choisit un jeu que le joueur en VR n'a pas, le chemin plat l'envoie par
le relais avec une barre de progression. **Cette version ne le fait pas.** L'écran
de lancement affiche une notice : le jeu n'est pas sur cet appareil, il faut le
lancer une fois hors VR.

**Pourquoi :** le transfert de ROM dans un casque est un chantier à lui seul, et
depuis que la bibliothèque est préparée dans IndexedDB avant l'entrée en VR
(`vr/prepare.ts`), le cas est rare. Ce qui est explicitement refusé, c'est de ne
pas traiter le cas du tout et de le laisser échouer sans explication.

---

## 3. L'écran de lancement

### Contenu

**Le jeu** — titre et jaquette, depuis le store `games`.

**D'où partir** — « Nouvelle partie », puis les sauvegardes de ce jeu trouvées
par CRC32 (D4). Inerte avec son explication si le salon n'est pas le sien (D3).

**S'il y a un groupe** — le port de manette (Joueur 1 / Joueur 2), l'état de
l'ami : présent, assis, prêt.

**Le bouton lancer.**

### Comportement

Cliquer un jeu sur le lutrin bibliothèque affiche son écran de lancement. Les
lutrins restent visibles : changer d'avis doit rester possible.

**Deux chemins l'ouvrent, et les deux comptent.**

*Le joueur en VR clique un jeu sur son lutrin.* En groupe, cela émet
`room:choose-game` — ce qui amène l'ami dans le salon (§1) — puis l'écran affiche
les options. En solo, rien n'est émis avant le lancement : le salon est créé à ce
moment, comme aujourd'hui.

*Ou l'ami choisit un jeu depuis sa page plate.* Le salon change, `room:updated`
arrive, et l'écran de lancement s'ouvre sur **son** choix sans que le joueur en
VR ait rien touché. C'est le seul chemin par lequel un jeu absent de l'appareil
peut atteindre cet écran — le lutrin, lui, ne montre que ce que l'appareil sait
ouvrir (`deviceLibrary($games, resolvable)`). C'est donc ici que vit le refus de
D7.

Lancer masque les panneaux, rend l'écran à son mode `DataTexture` et démarre le
moteur.

### Les neuf événements de session

`SessionEvent` (`znet/session.ts:103`) est une **interface** dont le champ
`type` énumère neuf valeurs : `state`, `desync`, `resync-start`,
`resync-done`, `rtt`, `link-lost`, `link-restored`, `error`, `peer-ready`.

Ce spec a d'abord annoncé **six**, et l'erreur méritait d'être corrigée plutôt
que masquée : j'avais compté les `case` du gestionnaire de `LockstepRoom` au
lieu de lire le type. J'ai mesuré un consommateur à la place du contrat — et ce
consommateur en laisse trois tomber en silence, ce qui est un défaut du chemin
plat, hors périmètre ici mais réel.

La VR traite les neuf, et son `switch` porte une assertion d'exhaustivité : un
`default` qui affecte la valeur à `never`, parce qu'un `switch` sans retour
n'est pas contrôlé par le compilateur — l'absence de `default` que ce plan
demandait d'abord ne protégeait de rien.

`error` renvoie à l'écran de lancement, panneaux relevés, avec son message :
sans les relever, la notice qui porte l'explication est invisible.

---

## 4. Le moteur : `rooms/lockstep-engine.ts`

L'équivalent netplay de `rooms/solo-engine.ts` (132 lignes), qui a rendu le solo
VR possible en isolant la séquence de démarrage de sa présentation.

**Les treize pas, sans présentation :**

1. `core` en paramètre, déjà chargé par l'appelant
2. `core.loadRom(normaliseRom(rom))`, la ROM en paramètre
3. `audio.start(Math.round(core.sampleRate))`
4. `if (isHost) await sram.load()` — **hôte seulement**, parce que l'état de
   l'hôte est celui que les deux adoptent et que charger la SRAM après
   changerait une machine et pas l'autre
5. `joinRelay()`
6. `SocketTransport`, éventuellement enveloppé dans `UpgradingTransport` (WebRTC)
7. `new NetplaySession({ core, transport, playerIndex, isHost, romCrc, fps,
   inputDelay, readLocalInput, onEvent, onFrame })`
8. `session.coreReset = () => core.reset()`
9. `new FrameGovernor(session, { fps, onSlice, schedule })`
10. l'écouteur `game:loaded` (D5)
11. `session.start(); governor.start()`
12. l'intervalle SRAM de 30 s
13. la persistance à l'arrêt

`LagTransport` est un outil de test piloté par `?lag=` et n'entre pas ici.

**Ce que la VR fournit à la place de la présentation**, et les trois pièces
existent déjà : l'écran incurvé pour la surface de rendu et `CanvasRenderer` ;
`resolveQuietly(crc32, { requestPermission: false })` pour `obtainRom()` ;
`readVrPad` pour `InputCollector` et son attirail de manettes.

**Taille attendue :** 250 à 350 lignes. Plus gros que `solo-engine.ts` à cause du
transport, de la jointure du relais et de la poignée de main ; même nature.

---

## 5. Erreurs

Chaque échec doit se nommer sur l'écran de lancement, jamais échouer en silence.
La leçon est datée : un écran noir dans le casque sans une ligne dans les
journaux a coûté une session entière le 2026-09-03, et le remède a été de faire
parler l'échec (`MissReason` dans `roms/provider.ts`).

| Cas | Ce que l'écran dit |
|---|---|
| ROM absente de l'appareil | le jeu n'est pas ici, le lancer une fois hors VR (D7) |
| Sauvegarde refusée par le serveur | l'explication de D3, avant même d'essayer |
| L'ami part avant le démarrage | retour à l'état sans groupe, le lancement solo reste offert |
| `desync` | la session le signale, l'hôte réamorce, l'écran le dit |
| `link-lost` / `link-restored` | affiché pendant la partie |
| `error` de session | message et retour à l'écran de lancement |

## 6. Tests

Sous Bun, sans navigateur ni casque, comme le reste de `vr/` :

- l'écran de lancement : régions calculées, absence de recouvrement, largeurs
  mesurées contre leur colonne — la méthode qui a attrapé le recouvrement des
  cartes du bandeau profil
- la liste inerte quand le joueur n'est pas créateur : les régions existent et ne
  répondent pas
- la recherche par CRC32, pas par `gameId` (D4)
- `lockstep-engine` : l'ordre des treize pas, avec des ports injectés — la SRAM
  chargée seulement par l'hôte, `session.start()` après `joinRelay()`
- chaque assertion prouvée capable d'échouer par mutation

`VrShell.svelte` et `TopBar.svelte` n'ont aucun harnais de composant dans ce
projet. C'est une dette connue, et trois bugs en sont sortis. Elle n'est pas
levée ici, mais toute logique de décision de ce projet vit dans un module de
`lib/`, testable — pas dans un composant.

## 7. Hors périmètre

- **Le transfert de ROM en VR** (D7)
- **Les modes streaming et dual** (D6)
- **Le choix du mode de latence depuis la VR** — réservé au créateur comme la
  sauvegarde ; la valeur mesurée par l'hôte reste celle qui s'applique
- **Plus de deux joueurs**
- **La page plate**, dont le demandeur note que le chemin des sauvegardes
  « n'est même pas naturel ». Si l'écran de lancement VR est réussi, il servira
  d'argument pour la revoir — plus tard, séparément.
- **Le réglage de `vr/layout.ts`** — l'azimut des lutrins à ±60° et les distances
  jamais mesurées dans un casque. Dette antérieure, indépendante.
- **L'invite de limite du Quest**, qui est un dialogue système qu'aucune API web
  n'atteint.
