# Une tablette flottante pour les menus d'options en VR

**Statut :** validé section par section le 2026-09-07, approche A retenue.
**Revient sur :** `2026-09-05-vr-remap-controles-design.md`, qui a posé le
panneau de remap **sur l'écran incurvé**. Cette décision-là est annulée : le
panneau était correct, sa place ne l'était pas.
**Lot 1 sur 2.** Le lot 2 — la manette SNES dessinée et la capture
séquentielle — a sa propre conception et n'est pas décrit ici.

## Le besoin, dans les mots du demandeur

> j'aimerais améliorer l'interface de setup des contrôles pour avoir qqch de
> graphique, avec la manette snes à l'image de ce qu'on a hors VR, avec aussi
> la possibilité de set tous les contrôles les uns apres les autres. bref
> parreil que hors VR. par contre en VR, autant profiter de l'effet VR et
> d'afficher la manette un peu devant l'écran, comme si elle flottait, pas
> collée sur l'écran

Puis, interrogé sur ce que l'écran devait montrer pendant le réglage :

> le mieux serait d'utiliser la tablette devant l'écran pour les menus
> d'options, et garder le jeu sur l'ecran de jeu

## 0. Pourquoi deux lots, et pourquoi celui-ci d'abord

La demande initiale portait sur un dessin. La réponse ci-dessus l'a transformée
en une règle sur **où vivent les menus** : la tablette porte les options,
l'écran porte le jeu. Le dessin n'est plus que le premier contenu de cette
tablette.

Construire le dessin d'abord signifierait le poser sur l'écran incurvé — celui
qu'on veut justement libérer — puis le déplacer. Donc la coquille d'abord. À la
fin de ce lot rien n'est plus joli, mais tout est à sa place, et c'est
vérifiable d'une seule observation : **le jeu reste visible pendant qu'on règle
les contrôles.**

## 1. Ce que cette décision annule

`openRemap()` (`VrShell.svelte`) commence aujourd'hui par `launchFor = null`.
Ouvrir les contrôles **abandonne donc l'écran de lancement**, et son
commentaire assume cette conséquence :

> *Picking a game hands the curved screen to the launch options, so the remap
> panel stands down rather than leaving its regions behind on a mesh that is
> drawing something else.*

Ce raisonnement était juste tant que les deux se disputaient une seule surface.
Il devient sans objet, et le `launchFor = null` disparaît.

`closeRemap()` rend l'écran au jeu ou à l'écran de lancement. Cette
restauration disparaît aussi : l'écran n'a jamais été pris.

Enfin, ce commentaire du dispatch décrit un partage qui cesse :

> *Before the launch screen's own branch: both live on
> `scene.screen.regions`.*

Le tableau de régions de l'écran était **multiplexé dans le temps** entre
l'écran de lancement et le panneau des contrôles. C'est la classe de défaut que
`panel.ts` décrit à propos de `hit()` — la première région gagne — appliquée à
deux panneaux qui ne sont jamais affichés ensemble mais partagent leur liste. Ce
partage n'existe plus après ce lot.

## 2. Ce qui existe et ne bouge pas

Vérifié dans le code avant toute décision. **Aucune modification serveur,
aucune migration.**

**La machinerie de panneau flottant existe déjà.** `scene.addPanel(id,
placement, size)` crée un quad à un `Placement` avec son canvas et sa texture,
et c'est ce qui porte les deux pupitres et le bandeau. Une tablette est un
quatrième appel, pas un nouveau type d'objet.

**Le panneau des contrôles ne change pas.** `panels/controls.ts` est déjà pur :
`layoutControlsPanel(state)` rend des régions, `drawControlsPanel` les
consomme. Il ignore complètement sur quelle surface il finit. Seul son
appelant change.

**La capture ne change pas.** `CaptureGate`, `listeningFor`, et la règle « aucune
région pendant une capture » (`vr-panel-controls.test.ts`) sont indépendantes
de la surface.

**Les invariants angulaires existent.** `vr-layout.test.ts` vérifie déjà que
chaque panneau a la forme de son canvas et porte à ±15 % les pixels par degré
du casque. Les chiffres de la section 3 en sont **déduits**, pas choisis.

## 3. La place de la tablette

```
TABLET_DISTANCE = 1.5   // rayon horizontal, droit devant
TABLET_DROP     = 0.50  // sous les yeux
TABLET_WIDTH    = 1.12
TABLET_HEIGHT   = 0.84
TABLET_PITCH    = -atan(0.50 / 1.5) = -18.4 degrés
```

Chaque nombre a une raison :

- **1,12 × 0,84** parce que 1,12/0,84 = 4/3 = 1024/768, la taille du canvas du
  panneau des contrôles. Le test d'aspect refuse tout autre couple : un
  panneau qui n'a pas la forme de son canvas étire tout son texte.
- **1,5 m** parce que son centre est alors à 1,581 m des yeux (le rayon n'est
  pas la distance — voir `eyeDistance`), qu'elle occupe **39,0°**, et que
  1024/39,0 = **26,3 px de canvas par degré** contre les 25 du Quest 3 : dans
  la bande de ±15 % que le test exige. Plus près elle gaspillerait des pixels,
  plus loin elle serait molle.
- **L'écran est à 2,5 m**, donc il reste **un mètre franc** entre les deux
  surfaces. C'est cette séparation qui produit la parallaxe demandée, et c'est
  la seule raison pour laquelle « flottant devant l'écran » veut dire quelque
  chose plutôt que « collé dessus ».
- **Le tangage de −18,4°** est exactement l'élévation de son centre vu des
  yeux, donc la tablette fait face au regard plutôt que de le prendre de
  biais. C'est le même calcul que le −40° des pupitres à 0,45 m de descente.
  `rotation.order = 'YXZ'` s'applique comme pour eux — `panel-mesh.ts` explique
  pourquoi l'ordre par défaut donnerait un roulis.
- **La descente de 0,50 m** est un arbitrage, et il est chiffré. L'image du
  jeu occupe −21,4° à +21,4° ; la tablette occupe −28,8° à −4,2°. Elle couvre
  donc l'écran de −21,4° à −4,2°, soit **les 40 % du bas de l'image**, et
  laisse les 60 % du haut libres. À hauteur d'yeux elle aurait masqué le
  centre, et garder le jeu derrière n'aurait alors rien voulu dire.

## 4. L'état : il n'y en a pas de nouveau

`remapOpen` devient `tabletOpen`. C'est tout.

Avec un seul écran d'options, l'état est « la tablette est ouverte », et une
union `TabletScreen` d'un seul membre serait de la cérémonie. Elle arrivera
avec un deuxième écran à distinguer — et le lot 2 n'en ajoute pas : la manette
**remplace** la liste, elle ne s'ajoute pas à elle.

C'est le point où l'approche A gagne contre l'approche B. B posait un écran
« menu d'options » dessiné sur la tablette, avec une pile de navigation. Cet
écran **dupliquerait le bandeau**, qui est déjà un lanceur depuis
`Decide where the room goes, and make the low band a launcher`. Le bouton
retour demandé existe donc déjà : c'est le `close` du panneau des contrôles, et
ce qu'il ramène est le bandeau, qui *est* le menu principal.

## 5. Le piège de la visibilité

`scene.aimedAt()` construit sa liste de cibles depuis `panelMeshes` dès que le
groupe des panneaux est visible. Masquer la tablette avec `mesh.visible =
false` ne suffirait **pas** : `Raycaster` ne teste que les layers, jamais la
visibilité —

```js
// three/src/core/Raycaster.js:240
if ( object.layers.test( raycaster.layers ) ) {
    const result = object.raycast( raycaster, intersects );
```

— donc une tablette fermée resterait cliquable en étant invisible. Le mode de
défaillance est le pire de sa catégorie : des pressées avalées par une surface
que le joueur ne voit pas, sur les pupitres qui se trouvent derrière elle.

`aimedAt` saute donc les panneaux dont `mesh.visible` est faux. Une ligne, et
elle fait de `mesh.visible` un contrôle réel pour **tout** panneau plutôt qu'un
cas particulier pour celui-ci.

## 6. L'occultation de la sortie

La tablette est à 1,5 m et le bandeau à 1,0 m. Elles peuvent donc se
**chevaucher en angle sans se toucher dans l'espace**, et la tablette
occulterait alors le bandeau — qui porte le seul chemin hors de la session.

Avec les chiffres de la section 3 : le bas de la tablette est à **−28,8°** et
le haut du bandeau à **−37,1°**, soit **8,3° de marge**. Confortable.

Une première estimation à la main donnait 3,4°, et elle était fausse : elle
traitait la tablette comme si elle n'était pas inclinée. Le tangage remonte son
bord bas de quatre degrés et demi, parce qu'il le ramène vers le joueur en même
temps qu'il le descend. C'est précisément pour ça qu'un test calcule la marge
au lieu qu'un commentaire l'affirme — et c'est le genre de défaut qu'on ne
découvrirait autrement que le casque sur la tête, en voyant la sortie
disparaître derrière une tablette.

## 7. Hors périmètre

- **La manette dessinée et la capture séquentielle** : lot 2. Ce lot déplace le
  panneau des contrôles tel quel.
- **L'écran de lancement reste sur l'écran incurvé.** Ce n'est pas un menu
  d'options mais le moment où l'on choisit un jeu, et à 2,5 m sur 60° d'arc la
  jaquette a une présence qu'une tablette lui retirerait. La règle est donc
  « l'écran porte le jeu, ou le choix d'un jeu ; la tablette porte les
  options ».
- **La tablette n'est pas permanente.** Elle suit la règle des autres panneaux
  et disparaît pendant le jeu. Une surface flottant entre le joueur et l'écran
  pendant une partie est précisément ce qu'on ne veut pas.
- **Un panneau de gestion des sauvegardes.** Toujours absent, et il aura sa
  propre conception. Le bandeau n'offre pas de bouton vers lui : un bouton qui
  n'ouvre rien est pire qu'un bouton absent.

## 8. Comment c'est vérifié

Sous Bun, donc sans casque : la forme de la tablette contre son canvas (4/3),
ses pixels par degré contre ceux du casque (26,3 contre 25), l'absence de
chevauchement angulaire avec le bandeau (8,3° de marge), et le fait qu'un
panneau invisible ne soit plus une cible.

**Ce que seul un casque peut trancher :** que le mètre de séparation se lise
comme de la profondeur plutôt que comme deux surfaces à la même distance, que
la moitié haute du jeu restée visible serve réellement à quelque chose pendant
un réglage, et que la tablette ne gêne pas la lecture du bandeau malgré ses
8,3° de marge.
