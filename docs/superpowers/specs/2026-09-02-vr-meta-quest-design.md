# Une expérience immersive pour Meta Quest

> **Révisé le 2026-09-05 :** la conclusion sur les contrôles — deux presets
> plutôt qu'un remap bouton par bouton — a été reprise. Voir
> `2026-09-05-vr-remap-controles-design.md`.

Conception. Issue [#25](https://github.com/pleymor/psnes-online/issues/25) :
« Créer une expérience immersive pour les utilisateurs de meta quest […] pour
l'instant, l'expérience VR sera juste un grand écran incurvé, comme Netflix,
avec ses amis à droite, sa bibliothèque de jeux à gauche, le menu profil (sans
le reglage des manettes) ».

## Pourquoi

Le repo ne contient rien de WebXR — `grep -riE "webxr|quest|immersive|three|aframe"`
sur `frontend/src` et `backend/src` ne rend que des faux positifs. Tout est à
écrire, et deux choses le rendent moins coûteux qu'il n'y paraît, tandis qu'une
troisième le rend plus coûteux.

**L'image est déjà prête.** `PsnesCore.videoSurface()` (`znet/core.ts:189`) rend
une vue RGBA sans copie dans la mémoire wasm, avec le `stride` exposé pour
`UNPACK_ROW_LENGTH` — l'entrée exacte d'un `texSubImage2D`. Un écran incurvé,
c'est un cylindre et un upload de texture.

**Le problème de cadence n'existe pas.** `FrameGovernor` est à accumulateur :
`slice()` (`znet/governor.ts:167`) lit `performance.now()`, borne l'écart à
250 ms, et déroule autant de ticks à 60,0988 Hz que le temps réel en mérite. Le
taux d'appel du callback ne l'intéresse pas. Et `schedule()` (`:139`) choisit
**déjà** entre `requestAnimationFrame` et un timer worker selon la visibilité de
l'onglet. « La rAF de la session XR » est donc un troisième cas dans un motif qui
existe, pas une seconde boucle parallèle. L'invariant que `webgl-renderer.ts:8`
écrit en majuscules — « ONE RULE ABOVE ALL: this drives nothing » — reste
intact : un callback à 72 ou 90 Hz produit le bon nombre de frames SNES sans
qu'une ligne du netcode change.

**Mais il n'y a pas de DOM en immersif.** `dom-overlay` est réservé à l'AR, et le
Quest ne le propose pas en `immersive-vr`. Les trois écrans que l'issue demande
— bibliothèque (`routes/+page.svelte`, 1050 lignes), amis
(`components/FriendsList.svelte`, 825 lignes), profil (`routes/profile/+page.svelte`,
927 lignes) — ne peuvent pas être réutilisés tels quels. **C'est là qu'est le
vrai coût du ticket, pas dans l'écran incurvé.**

## Ce qui a été décidé

Six questions, six réponses du propriétaire.

1. **Le périmètre** — tout en VR : le lobby **et** la partie, on ne quitte jamais
   l'immersif. Et **solo d'abord** : le lockstep en VR est hors v1.
2. **Les ROMs** — prérequis à plat. Le joueur ajoute ses jeux dans le navigateur
   plat du Quest, puis entre en VR. Le lobby VR n'affiche que le résoluble.
3. **La détection** — la **capacité** ouvre la porte, le **Quest** définit le
   contenu. `isSessionSupported('immersive-vr')` décide si le bouton existe ;
   l'hypothèse « deux manettes et rien d'autre » ne devient un fait que **dans**
   la session, où les entrées arrivent par `XRInputSource` quel que soit le
   casque. Un joueur PC avec un casque branché voit donc le bouton et obtient la
   même expérience, sans qu'on ait eu à reconnaître son matériel, et ses réglages
   à plat restent intacts derrière. Pas de sniffing d'UA.
4. **Le rendu** — three.js pour la scène, panneaux dessinés en `Canvas2D` et
   posés en textures. Ni Babylon ni son GUI (un moteur entier et un second
   paradigme d'UI pour ce qu'on peut écrire à la main), ni rastérisation du DOM
   par `html2canvas` (des centaines de millisecondes par passe, et un pont
   UV → `elementFromPoint` → événements synthétiques qui casse sur le premier
   `:hover`).
5. **La disposition** — « le poste de pilotage » : écran incurvé à 2,5 m, les deux
   panneaux latéraux en pupitres à 1,2 m, plus bas, inclinés vers l'intérieur.
   Écarté : l'arc unique où les trois panneaux sont sur un même cylindre à 3 m
   (illisible pour une grille de jaquettes) et le mur unique découpé en colonnes
   (une page web dans un casque, et l'écran doit rétrécir alors que « grand
   écran » était la promesse).
6. **Les manettes** — deux **préréglages** au choix, `letters` par défaut, en
   `localStorage`. Rectification assumée de l'issue : elle disait « inutile de
   permettre de set ses contrôles ». Choisir entre deux préréglages n'est pas
   rebinder bouton par bouton — personne n'a à construire son mapping, mais
   quelqu'un dont le pouce tombe au mauvais endroit peut le corriger d'un clic.

Et une décision explicitement **écartée** : faire passer les octets d'une ROM par
le serveur. Ça réglerait le problème des ROMs d'un coup et contredirait
frontalement `roms/device-library.ts:3` — « Le serveur tient l'identité d'un jeu,
jamais ses octets ».

## Le refactoring préalable

Lancer un jeu en VR a besoin de presque tout ce que fait `boot()` dans
`SoloRoom.svelte:463-583` : `loadCore`, `loadRom`/`normaliseRom`, la SRAM,
`AudioSink`, les `InputCollector` avec leurs sources et les écouteurs
`gamepadconnected`, `SoloSession`, `FrameGovernor`, le `teardown`. Tout sauf le
`RendererSurface`, le pad tactile et le plein écran.

Recopier ces 120 lignes dans le shell VR garantit que le prochain correctif sur
la SRAM ou sur l'assignation des manettes n'atteindra qu'une des deux copies.
On extrait donc **`lib/rooms/solo-engine.ts`** : le boot solo sans DOM, la
présentation en port.

```ts
createSoloEngine({
  rom: Uint8Array,               // déjà résolu — la résolution reste à l'appelant
  controls: ControlsConfig,
  sram: { load(): Promise<Uint8Array | null>; save(b: Uint8Array): void },
  onFrame(core: PsnesCore, frame: number): void,
  onError(err: unknown): void
}): { core, session, governor, audio, applySources(), stop() }
```

`SoloRoom` passe `renderer.draw(core)` dans `onFrame` ; `VrShell` passe
`screen.upload(core.videoSurface())`.

Deux choses restent délibérément dehors.

**La résolution de la ROM.** `SoloRoom.obtainRom()` ouvre la modale `LocateRom`
quand elle échoue, ce qui est impossible en immersif. L'engine prend donc des
octets : la décision 2 devient une frontière de type plutôt qu'une note de bas
de page.

**Le `MatchObserver`.** `onFrame` livre le numéro de frame ; l'appelant fait son
`observe()` lui-même. Il a le contexte de room qui rend une ligne intéressante,
l'engine non.

Ce refactoring part **en un commit à part, avant toute ligne de VR**, vérifié par
le jeu solo qui marche déjà. `SoloRoom.svelte` fait 1189 lignes de code vivant :
on n'extrait que ce que les deux présentations ont en commun.

## Les modules

| Fichier | Rôle | Testable sans casque |
|---|---|---|
| `vr/support.ts` | `isSessionSupported('immersive-vr')`, `navigator` injecté | oui |
| `vr/entry.ts` | le store que `TopBar` pousse et que `VrShell` lit | oui |
| `vr/xr-session.ts` | cycle de vie de la `XRSession`, espace de référence, `sessionend` | non |
| `vr/layout.ts` | rayons, angles, distances. Pur, sans import three | oui |
| `vr/scene.ts` | assemblage three.js : écran, pupitres, bandeau, rayons | non |
| `vr/screen.ts` | le cylindre et l'upload de `videoSurface()` | non |
| `vr/panel.ts` | canvas hors-écran, texture, `hit(regions, u, v)` | partiellement |
| `vr/panels/library.ts` | zones + dessin du pupitre gauche | zones oui |
| `vr/panels/friends.ts` | zones + dessin du pupitre droit | zones oui |
| `vr/panels/profile.ts` | zones + dessin du bandeau bas | zones oui |
| `vr/pointer.ts` | rayon manette → survol/`select` → le handler existant | non |
| `vr/pad.ts` | `XRInputSource.gamepad` → masque 12 bits | oui |
| `vr/pad-scheme.ts` | le préréglage stocké | oui |
| `components/VrShell.svelte` | monte la scène, tient l'engine | non |

`VrShell` est monté dans `+layout.svelte`, à côté d'`InvitationCard`, pour la
raison que le commentaire de la ligne 130 donne déjà : c'est le seul endroit qui
est à l'écran quoi que fasse le joueur. Le bouton d'entrée va dans `TopBar` avec
la forme `.bar-button` de « Amis », et communique par le store `vr/entry.ts` —
15 lignes, le même motif que `rooms/room-intent.ts`.

`navigator.xr` n'existant pas partout, `support.ts` prend son `navigator` en
paramètre, comme `connectedPads(nav = globalThis.navigator)` le fait déjà
(`znet/devices.ts:73`).

## La scène

Les valeurs vivent dans `vr/layout.ts`, **pur et sans import three**, précisément
pour être réglées au casque sans toucher au reste. Aucune ne sera juste du
premier coup ; c'est un réglage empirique, pas une décision d'architecture.

- **L'écran** : cylindre à 2,5 m, arc ±30°. Sa forme suit
  `readAspectPreference(localStorage)` — `'crt'` pour le 4:3 que les jeux
  visaient, `'square'` pour le 8:7 des pixels carrés. Réutilisé, pas réinventé.
- **Les pupitres** : plans à 1,2 m, à ±60° en azimut, abaissés à hauteur de
  poitrine, inclinés de 40° vers l'intérieur. Proches donc lisibles — la
  lisibilité dépend de la distance angulaire, pas de la taille du panneau, et
  c'est la raison qui a écarté les deux autres dispositions.
- **Le bandeau profil** : sous l'écran, à hauteur de taille, visible en baissant
  les yeux. Ce qui sert rarement se met là où il faut aller le chercher.
- **Pendant une partie**, les pupitres et le bandeau s'effacent : il ne reste que
  l'écran. Le clic du stick droit les rappelle.

**Le shader est forcé à vide en VR.** `xbrz/6xbrz` multiplie la surface par 36
avant même la stéréo ; ce budget n'existe pas sur Snapdragon. La préférence
stockée est laissée intacte, exactement comme `renderer-surface.ts:44` le décrit
déjà pour un shader indisponible : « the stored preference is deliberately left
alone: it is the player's choice ».

## L'entrée

Le SNES a quatre boutons d'action **en losange, sous un pouce**. Les Touch en ont
quatre, en **deux paires verticales, une par main** (gauche : Y en haut, X en
bas ; droite : B en haut, A en bas). Il n'existe pas de correspondance naturelle,
d'où les deux préréglages.

```ts
// [bouton du haut, bouton du bas] de chaque main
const FACE: Record<VrPadScheme, { left: [Button, Button]; right: [Button, Button] }> = {
  letters: { left: ['y', 'x'], right: ['b', 'a'] },  // ce qui est écrit est ce que le jeu nomme
  thumb:   { left: ['x', 'y'], right: ['a', 'b'] }   // sauter et courir sous le pouce au repos
};
```

`letters` est le défaut : « appuie sur B » désigne le bouton marqué B. `thumb`
place SNES B (le saut, le bas du losange) sur le bouton du bas de la main droite
et SNES Y (la course) sur celui du bas à gauche — là où les pouces reposent
déjà. Le préréglage ne touche **que** ces quatre boutons ; le reste de la table
est inconditionnel.

| SNES | Touch | code `xr-standard` |
|---|---|---|
| croix directionnelle | stick gauche, seuil 0,5 (le même `AXIS_THRESHOLD` que `znet/input.ts:31`) | `axes[2]`, `axes[3]` |
| L | gâchette gauche | `buttons[0]` G |
| R | gâchette droite | `buttons[0]` D |
| Select | grip gauche | `buttons[1]` G |
| Start | grip droit | `buttons[1]` D |
| — (rappeler les panneaux) | clic du stick droit | `buttons[3]` D |

**`xr-standard` n'est pas `standard`.** Le stick d'une Touch est sur
`axes[2]`/`axes[3]` ; les deux premiers axes sont réservés à un pavé tactile
absent. Or `STANDARD_PAD` (`controls/binding.ts:71-75`) dirige sur les axes 0 et
1 — `PadAxis1Minus` pour le haut, `PadAxis0Minus` pour la gauche. Réutiliser
cette table donnerait une croix directionnelle morte, sans erreur ni
avertissement. C'est pourquoi `vr/pad.ts` est un module à part avec sa
propre table : il produit le même masque 12 bits que `InputCollector`, mais il ne
partage pas ses codes.

**Aucun bouton ne peut quitter la VR.** Le bouton menu du Quest est réservé au
système et ne remonte rien à la page. La sortie est donc en jeu : le bandeau
profil porte « quitter la VR ».

**Une manette Bluetooth appairée au Quest reste visible dans
`navigator.getGamepads()` pendant une session immersive.** Le chemin
`InputCollector` existant continue donc de marcher gratuitement pour qui en a
une, sans code supplémentaire.

**Le préréglage est stocké en `localStorage`**, clé `psnes-vr-pad`, sur la forme
exacte de `stores/shader-preference.ts` : `storage` en paramètre plutôt que
`localStorage` attrapé, valeur inconnue purgée à la lecture, clé **supprimée**
plutôt que vidée — « no reader has to treat '' and absent as the same thing »
(`shader-preference.ts:41`). L'interface `PreferenceStorage` y est déjà exportée.

Le coût honnête : deux casques, deux réglages. `znet/devices.ts:5` accepte déjà
ce compromis pour une raison voisine, moins bien fondée ici puisque le pouce
voyage avec la personne. Le compte exigerait de toucher au schéma et à
`normaliseControlsConfig` ; ce n'est pas la v1.

**L'interrupteur vit dans le bandeau profil en VR, et nulle part ailleurs.** Le
seul moyen de choisir entre ces deux préréglages est de les *sentir*, et on ne
les sent que casque sur la tête ; un réglage pour du matériel absent est une case
cochée au hasard. Le schéma des deux manettes est dessiné à côté de chaque
préréglage — on dessine déjà le panneau au `Canvas2D`, ça ne coûte presque rien,
et ça répond directement à l'objection « les lettres mentent ».

## Les panneaux

**Le pupitre gauche — bibliothèque.** `deviceLibrary($games, resolvable)`, la
même règle que `+page.svelte`, celle que `device-library.ts:8` appelle « le seul
endroit où l'écran cesse de mentir ». Grille de jaquettes, titres, scroll au
stick. Un `select` lance en solo.

Le vide distingue les **deux** vides comme la page à plat le fait déjà
(`+page.svelte:496`) : « ta bibliothèque est vide » dit à quelqu'un qui a deux
cents jeux qu'il n'en a aucun. En VR, le second cas gagne un mot de plus — sors
du casque, ajoute tes jeux, reviens.

Absents du pupitre, et volontairement : les détails du jeu, la suppression,
`IdentifyGame`, `LinkRom`. Ce sont des gestes de gestion, ils restent à plat.

**Les jaquettes se chargent telles quelles.** `/api/covers/:metadataId` est servi
en **même origine** avec le cookie de session (`api/covers.ts:9`). Ça compte :
uploader un canvas *tainted* dans une texture WebGL lève une `SecurityError`, et
une jaquette servie par un tiers aurait cassé toute l'approche. Ne **pas** poser
d'attribut `crossOrigin` — l'endpoint n'envoie pas d'en-têtes CORS, et le mettre
casserait le cookie.

**Le pupitre droit — amis.** En lecture seule : qui est en ligne, qui joue à
quoi, depuis `activeRooms` et le socket. Pas d'invitation (elle ouvre une room,
et une room mène au lockstep, hors v1), pas d'ajout d'ami (il faut taper un
pseudo et il n'y a pas de clavier en immersif), pas de retrait. C'est une
vitrine, assumée comme telle : voir ses amis en ligne est une raison de revenir,
et le coût est faible puisque les données arrivent déjà.

**Le bandeau bas — profil.** Identité (avatar + pseudo), le préréglage de manette
avec son schéma, la langue, « quitter la VR ». Rien d'autre : ni source de ROMs
(pas de sélecteur de fichiers en immersif), ni config portable (des fichiers), ni
suppression de compte.

**Les sauvegardes.** L'issue n'en parle pas, il faut quand même trancher. La
**SRAM marche gratuitement** : elle vient avec `solo-engine`, qui porte le
`setInterval(persistSram, 30000)` de `SoloRoom.svelte:561` — un jeu à pile
sauvegarde comme sur la cartouche. Les *savestates* (`quickSave`/`quickLoad`,
aujourd'hui sur des touches clavier) restent hors v1 : plus aucun bouton libre
sur les Touch, et il faudrait leur inventer une grammaire.

## Lancer un jeu sans naviguer

`launchSolo` (`rooms/actions.ts:128`) fait deux choses : `createRoom({ autoStart:
true })`, puis `goto('/room/:id')`. La VR veut la première et **surtout pas** la
seconde — naviguer monterait `SoloRoom.svelte` sous la session immersive, donc un
**second** émulateur : deux cores, deux `AudioContext`, deux gouverneurs, deux
écrivains de SRAM sur la même room. Le shell VR appelle donc `createRoom`
directement et ne navigue jamais ; `launchSolo` reste le wrapper de l'app à plat.

Le `roomId` obtenu est ce qui donne un sens au port `sram` de l'engine : la SRAM
passe par le socket, adressée à une room, exactement comme à plat.

**Et il reste un chemin par lequel la navigation peut arriver quand même.**
`room:opened` est émis par `room:choose-game` (`websocket/room-handlers.ts:237`),
**pas** par `room:create` — un lancement solo depuis la VR ne déclenche donc rien.
Mais `openRoomForMembers` (`:710`) adresse **tous** les membres de la room, « both
members go, including the one who just chose ». Un joueur qui était en groupe
avant d'entrer en VR, et dont le partenaire choisit un jeu, verrait
`handleRoomOpened` (`+layout.svelte:47`) faire un `goto` sous sa session
immersive. D'où une garde à cet endroit précis : tant qu'une session XR est
active, on ignore la navigation. C'est le seul endroit qui agit sur
`room:opened`, et son commentaire dit déjà pourquoi ce genre de décision vit là.

C'est aussi la seconde raison de monter `VrShell` dans `+layout.svelte` : il est
au-dessus du `<slot />`, donc une navigation ne le démonterait pas de toute
façon.

## Cycle de vie et erreurs

**L'entrée.** Le bouton `TopBar` fournit le geste DOM que `requestSession` exige.
`requiredFeatures: ['local-floor']` pour une hauteur de sol réelle, repli sur
`'local'` avec une hauteur d'œil supposée si le casque la refuse. Une session
refusée (permission, session déjà active) laisse une notice à plat et le bouton
en place.

**Le piège du bouton collé.** Quand le menu système du Quest s'ouvre, la session
passe en `visible-blurred` : **la rAF XR continue de tirer, mais les entrées ne
sont plus livrées**. Un bouton tenu à cet instant resterait tenu pour l'éternité,
et le personnage courrait vers la droite tout seul. `vr/pad.ts` renvoie donc 0
dès que `visibilityState !== 'visible'` — mot pour mot le raisonnement de
`InputCollector.onBlur = () => this.held.clear()` (`znet/input.ts:66`), transposé
au monde XR.

**La sortie, une seule.** Notre bouton, le menu système, le casque posé sur la
table : tout arrive par `sessionend`, et il n'y a qu'un chemin. `engine.stop()`
persiste la SRAM une dernière fois — sans quoi jusqu'à 30 s de progression
partent — puis libère les textures et le renderer, et rend l'app à plat sur la
bibliothèque.

**Un lancement qui échoue à l'intérieur.** `resolvable` est calculé au montage,
mais une permission de dossier peut se perdre entre-temps. Le chemin VR passe
donc par `resolveQuietly` (déjà importé par `SoloRoom.svelte:28`), et un `null`
devient une notice **dans le panneau**, jamais une modale. Le jeu reste dans la
liste : il existe, on n'a simplement pas pu le lire cette fois.

**L'audio.** `AudioSink.start()` crée son contexte avec la fréquence du core
(`znet/output.ts:181`), donc impossible de le débloquer avant de savoir quel jeu
se lance. Et `needsGesture` existe sous forme de question et non d'hypothèse pour
une raison écrite noir sur blanc à `output.ts:199` : « callers that assumed
otherwise showed a "click for sound" button that did nothing ». En VR le jeu est
lancé par un `select` de manette, pas par un clic DOM, et on ne parie pas sur le
fait que ça vaille activation utilisateur. On reprend donc la forme de la
solution existante, en jeu : si `needsGesture` est vrai après `start()`, un
panneau « appuyer pour le son » apparaît, et son `select` appelle `resume()`.

**Le contexte WebGL perdu.** À plat, `renderer-surface.ts` retombe sur le canvas
2D. En VR il n'y a pas de repli : on termine la session proprement et on rend
l'app à plat avec une notice, plutôt que de laisser quelqu'un dans un monde noir
à se demander si le jeu a planté.

## Les tests

`panel.ts` a besoin d'un canvas, que `bun test` n'a pas. Plutôt que de renoncer,
ça force le bon découpage : **la mise en page est une fonction pure qui rend une
liste de zones**, et le dessin la consomme.

```ts
/** Une zone cliquable, en pixels du canvas du panneau. */
interface Region { id: string; x: number; y: number; w: number; h: number }
/** La taille du canvas d'un panneau, en pixels. */
interface PanelSize { width: number; height: number }

layoutLibraryPanel(games: Game[], size: PanelSize, scroll: number): Region[]  // pur, testé
drawLibraryPanel(ctx: CanvasRenderingContext2D, regions: Region[], games: Game[]): void  // impur
hit(regions: Region[], u: number, v: number): Region | null                   // pur, testé
```

`hit` prend l'`uv` que `Raycaster.intersectObject` rend et le convertit en
pixels du canvas — c'est toute la traduction entre le monde 3D et les panneaux,
et elle tient dans une fonction pure.

Testés : `support.ts` (navigator injecté), `layout.ts` (géométrie pure),
`pad.ts` (faux `XRInputSource` → masque ; les deux préréglages ;
`visible-blurred` → 0), `pad-scheme.ts` (faux storage), les zones des trois
panneaux, `hit()`.

Non testés : la scène three.js, la session XR, le dessin. Même posture que celle
que `webgl-renderer.ts:15` assume déjà explicitement — « written to fail into the
2D path rather than to be caught by a test ».

**La convention à ne pas rater :** chaque nouveau fichier va dans `core/test/`,
**et doit être ajouté à la main à la liste `test:ui`** du `package.json` racine.
C'est le piège que le commit `cec4257` (« Run the three test files nobody was
running ») vient de réparer.

## À vérifier au casque

Trois choses que ce document ne peut pas trancher depuis un terminal, et qui
demandent un Quest en main :

1. **Les distances et les angles.** 2,5 m / 1,2 m / 40° / ±55° sont des points de
   départ raisonnés, pas mesurés. `vr/layout.ts` existe pour qu'on les corrige.
2. **Le budget de frame.** Rendu stéréo, plus snes9x en wasm, plus la texture de
   l'écran et les trois textures de panneau : ça devrait tenir, shader coupé. Si
   ça ne tient pas, le premier levier est de ne redessiner un panneau que quand
   ses données changent, plutôt qu'à chaque frame — seule la texture de l'écran a
   besoin d'être réuploadée à 60 Hz.
3. **L'activation utilisateur d'un `select` XR.** Le panneau « appuyer pour le
   son » est le repli conçu pour le cas où elle ne compte pas. Si elle compte, le
   panneau n'apparaîtra jamais et c'est très bien.

## Hors périmètre de cette v1

Le lockstep en VR, l'invitation depuis le pupitre amis, les savestates, la source
de ROMs en immersif, la config portable, la suppression de compte, le rebinding
bouton par bouton, les mains sans manettes (`hand-tracking`), l'audio spatialisé,
et tout multijoueur. Chacun est une v2 possible ; aucun n'est nécessaire pour
qu'un joueur mette un casque, voie sa bibliothèque, choisisse un jeu et y joue
sur un grand écran incurvé.
