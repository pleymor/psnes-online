# Un monde Mario à la place de la salle noire, en VR

**Statut :** validé section par section le 2026-09-11, approche A retenue.
**Portée :** le lobby uniquement. Pendant une partie, la scène redevient
exactement ce qu'elle est aujourd'hui.
**Ne touche pas :** les panneaux existants (pupitres, tablette, bandeau,
écran). Leur habillage est une décision séparée, explicitement remise à plus
tard.

## Le besoin, dans les mots du demandeur

> dans un worktree, voyons comment améliorer l'xp VR. déjà j'aimerais qu'on
> soit non pas dans une salle noire mais dans un monde mario.

Le « déjà » est à prendre au sérieux : c'est le premier point d'une liste plus
longue sur l'expérience VR. Cette spec ne traite que celui-là.

Les cinq réponses de cadrage, qui ferment autant de portes :

- **Quand ?** Lobby seulement. « dès qu'une partie démarre, retour au fond
  sombre pour ne rien voler au jeu ».
- **Quel registre ?** Pixel-art SNES assumé — aplats, gros pixels, on reconnaît
  World 1-1. Pas du « Mario en volume », pas un clin d'œil discret.
- **Quelle enveloppe ?** 360°, **avec un vrai sol** sous les pieds.
- **Combien de vie ?** Monde vivant : des sprites animés, pas seulement des
  nuages qui dérivent.
- **Et les panneaux ?** Inchangés pour l'instant.

Aucun asset n'est extrait d'un jeu Nintendo. Tout l'art de ce monde est dessiné
dans le dépôt, sous forme de grilles de caractères (§5). C'est aussi le choix
pratique : le projet n'a aucun pipeline d'assets, et n'en gagne pas un ici.

## 0. Ce que la scène est aujourd'hui, et ce que ça impose

Quatre faits tirés du code, qui éliminent des options avant toute discussion de
goût.

1. **Rien n'est éclairé.** `scene.ts` : « Every material is unlit
   MeshBasicMaterial, so there are no lights. » Le décor vit sous cette règle
   ou introduit un autre moteur de rendu. Il vit sous cette règle.
2. **La caméra a un `far` de 50 m.** Tout doit tenir dedans.
3. **`y = 0` est l'œil, pas le sol.** La session demande l'espace `local`
   uniquement, dont l'origine est la pose de la tête à l'ouverture.
   `layout.ts` mesure tout à partir de là. Il n'y a **aucune** hauteur de sol
   connue dans cette scène.
4. **L'écran est réglable en distance, jusqu'à 4,3 m.**
   `SCREEN_DISTANCES = [2.0, 2.5, 3.0, 3.6, 4.3]`, cinq angles jusqu'à 80°,
   cinq hauteurs, deux formes, **et deux rapports de pixel**. Mesuré sur les
   100 combinaisons : **le point le plus lointain de l'écran est à 5,281 m**
   (plat, 80°, 4,3 m, décalé de 0,4 m, pixels carrés).

   Le rapport compte et c'est un piège : `aspectRatioOf` renvoie 4/3 en `crt`
   mais **8/7 en `square`**, et le plus petit rapport donne l'écran le plus
   *haut*, donc le coin le plus lointain. Ne mesurer que le 4/3 donne 5,175 m
   — 11 cm d'erreur dans le sens dangereux.

   Ce nombre commande toute la profondeur du décor, et une première version de
   cette conception l'avait fixée à 3,5 m en croyant l'écran à 2,5 m — ce qui
   aurait masqué l'image du jeu sur les deux crans les plus éloignés.

## 1. L'approche retenue, et les deux écartées

**A — Théâtre de papier. Retenue.** Le décor est un empilement de surfaces
pixel-art **à des profondeurs différentes** : dôme de ciel en aplat, collines,
nuages, objets proches, sol carrelé. L'art reste plat ; c'est la **parallaxe
entre les calques** qui donne la profondeur.

Elle gagne pour deux raisons. La première est qu'elle n'introduit aucun concept
nouveau : le moteur dessine déjà des quads non éclairés portant une texture de
canvas — c'est `panel-mesh.ts` en entier. La seconde est qu'elle prend le
registre au mot plutôt que de le contredire : **un décor SNES est déjà fait de
calques à défilement différentiel.** On ne fait que les écarter en profondeur.

**B — Le monde en volume.** Géométrie 3D véritable. Écartée : un tuyau de SMB
n'a pas de dos, et lui en modeler un bascule dans le registre « Mario en
volume » que le demandeur a explicitement écarté. Dix fois la géométrie pour un
résultat que A obtient par l'écartement des calques. *(Nuance : §6 réintroduit
une boîte à quatre faces pour les objets proches. Ce n'est pas B — c'est le
même dessin plat, assemblé, sans une seule image d'art supplémentaire.)*

**C — Un panorama 360° unique.** Une texture cylindrique géante plus un sol.
Écartée : c'est précisément l'effet papier peint. Une surface unique à distance
constante est lue par la stéréo comme une image collée sur une sphère.

## 2. L'échelle : taille Mario

**1 bloc = 1 mètre.** Le joueur est dans le niveau, à la taille du personnage.

Ce que ça fixe : tuile de sol d'1 m, tuyau de 2 m, rangée de blocs `?` à
+1,2 m au-dessus de l'œil, goomba de 0,9 m. Les sprites sont vus de près, donc
ils doivent tenir le détail — c'est le coût de ce choix, et il se paie en
dessin (§5).

## 3. Les modules

Piège de nommage d'abord : `scene.ts` a **déjà** un `THREE.Group` nommé `world`
— c'est la pièce ancrée, celle que `recenter()` déplace. Le monde Mario
s'appelle donc **le décor**, dans `frontend/src/lib/vr/decor/`. Ne pas revenir
sur ce point : deux « world » dans ce fichier le rendraient illisible.

| Module | Rôle | three ? |
|---|---|---|
| `decor/palette.ts` | Les couleurs nommées. Source unique. | non |
| `decor/pixels.ts` | Grille de caractères + palette → RGBA. | non |
| `decor/art/*.ts` | Les grilles : tuiles, tuyau, bloc `?`, goomba, nuage… | non |
| `decor/composition.ts` | **Le pendant de `layout.ts`** : distance, azimut, hauteur, échelle de chaque élément. Que des nombres. | non |
| `decor/motion.ts` | `t` → index d'image, position, dérive. Déterministe. | non |
| `decor/floor.ts` | La hauteur du sol, derrière un port. | non |
| `decor/build.ts` | **Le seul qui importe three.** Meshes, `update(t)`, `setVisible()`, `dispose()`. | oui |

Le motif est celui du dépôt, et il a déjà payé : sans casque et sans GPU sous
Bun, la seule façon de tenir une géométrie responsable est de la sortir du code
qui dessine. `layout.ts` a attrapé deux erreurs de signe grâce à cette
séparation ; `composition.ts` en est la copie conforme.

### Ce que `scene.ts` gagne

- **Un deuxième groupe, `room`** (§4.1).
- **`decorVisible(boolean)`**, appelé par `VrShell` (§8).
- **`onFrame` passe le temps** : `(fn: () => void)` devient
  `(fn: (t: number) => void)`. Ripple vérifié — un seul appelant,
  `VrShell.svelte:2843`, et un callback sans argument reste valide là où on en
  passe un. Une ligne, zéro churn.

## 4. Le sol : trois problèmes distincts

### 4.1 L'ancre porte le `y` de la tête

`anchor.ts` renvoie `position` telle quelle, les trois composantes, et
`scene.ts` fait `world.position.set(...anchor.position)`. Le groupe qui porte
la pièce est donc calé sur **la hauteur de la tête au dernier recentrage**.

Pour les pupitres c'est exactement ce qu'on veut : ils sont un cockpit accroché
au joueur. Pour un sol, c'est le pire comportement possible — se lever et
recentrer ferait **monter le sol** avec soi.

**Correction structurelle, pas facteur correctif :** `scene.ts` gagne un
deuxième groupe, `room`, qui reçoit du recentrage le `x`, le `z` et le lacet,
**mais pas le `y`**. Le décor vit dedans. Deux lignes dans le bloc
`recenterPending`, et ça énonce une vraie distinction : les panneaux sont un
cockpit, le décor est un lieu posé par terre.

`room.position.y` vaut donc **toujours zéro**. Autrement dit, à l'intérieur de
`room`, l'axe vertical est celui de l'espace de référence : le sol s'y place à
`-floorHeight` (§4.2) et n'en bouge plus jamais, quel que soit le nombre de
recentrages. C'est la formulation à retenir — « le groupe ne prend pas le `y` »
est le moyen ; « le sol est exprimé en hauteur de référence » est la propriété.

### 4.2 À quelle hauteur

`xr-session.ts` a mesuré `local-floor: NotSupportedError` sur le Quest du
demandeur le 2026-09-07 — mais le fichier dit lui-même pourquoi : *« That is
the conformant refusal for a feature that was not asked for. »* La session ne
négocie aucune feature.

**Décision :** demander `optionalFeatures: ['local-floor']`, puis, sur la
première image valide, lire `frame.getPose(localFloorSpace, localSpace)` — son
`y` **est** l'offset du sol. Repli sur **1,20 m** constant si le casque refuse.

Le `local-floor` sert **uniquement à mesurer**. L'ancrage ne change pas : three
continue de travailler dans son propre `local`. Cette phrase est là parce que
`xr-session.ts` porte l'avertissement « que personne ne retire ce levier une
quatrième fois », et il faut être net sur ce qu'on touche.

Risque résiduel, énoncé : ajouter une feature change ce que le runtime
provisionne, donc éventuellement le comportement du Guardian. Ça se vérifie en
une session ; l'annulation est la suppression d'un argument.

**Pas de réglage « hauteur des yeux » dans la tablette d'options.** Un mode de
plus pour un nombre qu'on sait mesurer. Si la mesure échoue, l'erreur du repli
est de 20 à 30 cm chez un joueur assis : le monde paraît un peu plus grand,
rien ne casse. Le réglage s'ajoutera après la première session s'il se justifie
— en connaissance de cause.

### 4.3 Le filtrage, où la règle du projet s'inverse

`panel-mesh.ts` interdit les mipmaps, et son raisonnement est écrit : les
pupitres sont à ~1:1 pixel-canvas contre pixel-affiché, donc un niveau de mip
ne protège aucun détail et ne fait que flouter le texte.

**Un sol carrelé vu en incidence rasante est le cas exactement opposé.** À dix
mètres, une tuile d'1 m occupe une poignée de pixels ; le point-sampling y
produit un moiré qui grouille. Donc, pour le sol seulement :

- `NearestFilter` en **magnification** — les gros pixels de près, c'est le style ;
- mipmaps + anisotropie en **minification**.

Le commentaire dans le code doit renvoyer à `panel-mesh.ts`, sinon la prochaine
lecture y verra une incohérence.

### 4.4 Pas de brouillard

Ce serait la façon paresseuse de cacher le bord lointain du sol, et ça
trahirait le registre : un décor SNES a des aplats francs, pas de dégradé
atmosphérique. À la place, **le sol s'arrête là où le dôme de ciel descend**, et
la bande basse du dôme porte le même vert. La jointure disparaît parce que les
deux surfaces se touchent sur la même couleur.

Les rayons, tous sous le `far` de 50 m de la caméra (§0) :

```
DÉCOR_PROCHE   6 m      rien de décor en deçà
objets proches 7 – 9 m  blocs, pièces, tuyaux (boîtes)
goombas        11 – 14 m
nuages         15 m
collines       20 m
DÔME / SOL     30 m     le sol s'arrête exactement là, sur la même couleur
```

## 5. L'art : format, densité, atlas

### 5.1 Le format

Grille de caractères plus palette. Lisible en diff, modifiable sans outil, pur :

```ts
export const QUESTION_BLOCK = {
  palette: { o: 'brickDark', y: 'blockYellow', h: 'blockHi', k: 'outline' },
  rows: ['kkkkkkkk', 'kyyyyyyk', 'kyhhhhyk', 'kyhkkhyk', /* … */]
};
```

`pixels.ts` en fait du RGBA. Arithmétique pure, donc testable.

### 5.2 La densité : un seul nombre

**`ART_PIXELS_PER_METRE = 16`**, la résolution native d'une tuile SMB.

Tout le reste se calcule au lieu de s'espérer. Un bloc d'1 m à 7 m couvre
8,2° de vision ; ses 16 pixels d'art font donc 1,95 pixel d'art par degré,
contre les **25 pixels d'affichage par degré** que `layout.ts` documente pour
le Quest 3. Chaque pixel d'art occupe donc **environ 13 pixels à l'écran**.
C'est ça, « gros pixels assumés », et c'est la même unité que celle qui a servi
à diagnostiquer le flou des jaquettes.

### 5.3 Un seul atlas

Tuiles, tuyaux, blocs, collines, buissons, nuages, sprites et leurs images
d'animation : **une texture unique** en `NearestFilter`, les objets étant des
quads qui en découpent un sous-rectangle en UV.

Trois conséquences, dont une décisive : un seul téléversement et un seul bind ;
ajouter un motif ne touche pas le code de rendu ; et **tout l'art du monde est
visible d'un coup dans un seul PNG**, ce qui est la planche de référence du
développement (§10).

Le ciel n'y est pas : le dôme est un **aplat** (le bleu de SMB), et les nuages
sont des quads posés devant. Sans ça il faudrait une texture panoramique de
4 000 pixels de large pour peindre du bleu uni.

## 6. La géométrie : plat, billboard ou boîte

Même assis et immobile, **la stéréo donne deux points de vue écartés de 6 cm**.
C'est elle qui démasque une surface plate, pas le mouvement. D'où une règle par
distance plutôt qu'un traitement unique :

| Quoi | Traitement | Pourquoi |
|---|---|---|
| Objets à moins de 12 m (tuyaux, blocs, buissons) | **Boîte pixel-art** : face avant + deux côtés en teinte assombrie + dessus | La stéréo y voit le volume. L'objet est *posé*, pas *collé*. Coût : 4 faces au lieu d'1 et une couleur de côté par motif — **zéro image d'art supplémentaire** |
| Nuages | **Billboard** (pivot sur Y) | Le pivot est indétectable à cette distance, et ça évite de les dessiner sous trois angles |
| Collines à 20 m | **Plat, orientation fixe** | La stéréo n'y distingue plus rien, et l'orientation fixe garde la silhouette franche |
| Sprites vivants (goomba, plante) | **Billboard** | Un sprite de jeu 2D n'a jamais eu de dos. Lui en donner un serait le seul endroit où l'on trahirait vraiment le registre |

## 7. Le mouvement et le confort

**Animer un sprite ne coûte rien.** Conséquence directe de l'atlas : changer
d'image, c'est décaler deux UV. Aucun redessin de canvas, aucun téléversement
de texture. À comparer avec l'avertissement de `panel-mesh.ts` — « trois
panneaux re-rasterisés à 72 Hz coûteraient plus que l'émulateur » : c'est une
autre catégorie de dépense.

`motion.ts` est pur, `t → état` :

```ts
spriteFrame(t, { frames, hz })       // index d'image
patrol(t, { from, to, speed })       // un goomba
drift(t, { start, speed })           // un nuage
piranha(t, { period, outFor })       // sortie/rentrée de la plante
```

### Trois règles de confort, qui sont des contraintes de design

1. **Rien ne traverse le champ de vision central.** Les goombas patrouillent
   latéralement à 11-14 m, à ~1 m/s : moins de 5°/s. Le mouvement rapide près
   du centre est ce qui donne la nausée.
2. **Aucun mouvement de grande surface.** Pas de défilement du décor, pas de
   sol qui bouge. La vection — l'illusion d'être déplacé — vient des grands
   champs en mouvement, et c'est la cause première du malaise en VR. Les nuages
   dérivent à 0,05 m/s : vivant, pas ressenti.
3. **Rien ne clignote au-dessus de 3 Hz.**

### Le casting de départ

| Quoi | Où | Images d'art à produire |
|---|---|---|
| Bloc `?` qui pulse | 7 m, au-dessus du regard | **0** — cyclage de palette, comme l'original |
| Pièce qui tourne | 8 m, trois en rang | 4 |
| Goomba qui marche | 11-14 m, deux qui patrouillent | 2 |
| Plante carnivore | tuyau à 9 m | 2 |
| Nuages qui dérivent | 15 m | 0 (une image, déplacée) |

**Huit images d'art en tout** pour tout le mouvement. Le bloc `?` en coûte zéro
parce qu'on anime la palette et pas la grille — le moins cher **et** le plus
fidèle, puisque c'est littéralement ce que faisait la NES.

Quand une partie tourne, `update()` sort sur le booléen de visibilité : le coût
du décor pendant le jeu est un `if` par image.

## 8. La bascule lobby ↔ jeu, et le rideau

### Le signal

Pas `screen.isPanel()` — c'est un détail de ce qui est peint sur le mesh.
C'est `VrShell` qui sait si une partie tourne, et qui appelle
`decorVisible(boolean)`, comme il décide déjà `panelsVisible`.

*Porte laissée ouverte, non ouverte :* lier le décor aux **panneaux** plutôt
qu'à la partie — pour qu'ouvrir le menu des amis en cours de jeu rende le monde
au lieu d'un vide noir — serait le changement d'une condition. Le demandeur a
demandé « dès qu'une partie démarre, retour au fond sombre » ; c'est ce qui est
livré.

### Le rideau

Passer d'un ciel bleu plein champ à du quasi-noir d'une image à l'autre est un
à-coup de luminance sur toute la rétine, et le retour est pire. Fondu d'environ
**0,4 s**.

Plutôt que de faire varier l'opacité de chaque matériau du décor — ce qui
obligerait à basculer chaque cutout de sprite entre `alphaTest` et
`transparent`, avec les problèmes de tri qui vont avec — **un seul objet : une
sphère en `BackSide`, couleur `0x0a0a12`, dont on anime l'opacité de 0 à 1.**

Son rayon est l'arbitrage central de cette section :

```
point le plus lointain de l'écran (mesuré sur 100 crans) : 5,281 m
RIDEAU                                                   : 5,5 m   (marge 0,22 m)
DÉCOR_PROCHE (rien de décor en deçà)                     : 6,0 m
```

Le rideau masque donc **exactement le décor et rien d'autre** : l'écran de jeu
et les pupitres restent devant lui quel que soit le réglage du joueur. Et quand
il est opaque, il porte la couleur du fond actuel — on retrouve littéralement
la salle noire d'aujourd'hui. Un objet, un matériau, aucun état par-matériau :
la correction est vraie par construction plutôt que par vigilance.

Le fondu terminé, **le décor et le rideau passent tous deux à
`visible = false`** : plus aucun appel de dessin pendant la partie. Rien ne
change à l'image pour autant, et c'est voulu — ce qui apparaît derrière est
`scene.background`, qui porte déjà exactement la même couleur `0x0a0a12`. Le
rideau n'a donc à être opaque que le temps du fondu ; c'est le fond de la scène
qui tient le noir ensuite, gratuitement.

### Un point à mesurer, pas à pré-optimiser

`scene.ts` met délibérément `setFoveation(0)`, et son argumentaire écrit est
« il n'y a rien sur quoi dépenser le fill rate : quatre quads non éclairés,
deux lignes, aucune lumière ». **Le décor rend cette phrase fausse dans le
lobby.** Il y a de la marge — aucun émulateur ne tourne à ce moment-là — mais
c'est exactement le genre d'affirmation qu'il ne faut pas avancer sans
instrument.

Donc : livrer à foveation 0, regarder le compteur d'images dans le lobby, et
*si* ça descend, tirer le levier propre — une foveation non nulle dans le lobby
seulement, remise à 0 au démarrage du jeu. Pas avant la mesure.

## 9. Les lots

Ordonnés sur **le risque d'abord, puis le pari**. Chacun se termine par quelque
chose qui se juge casque sur la tête.

**Lot 1 — Le sol et le ciel.** `palette`, `pixels`, `composition`, `floor`,
`build`, le rideau, la bascule, le groupe `room`, `optionalFeatures`. Une seule
tuile à dessiner ; tout le risque technique est ici.
→ *On juge :* être debout sur un sol de briques sous un ciel bleu, à une
hauteur qui paraît juste. Lancer un jeu : fondu vers la salle noire.

**Lot 2 — Le relief.** Collines, buissons, nuages.
→ *On juge :* **le pari de l'approche A.** Seul moment où l'on saura si
l'empilement bat l'effet papier peint. Si la réponse est non, on le découvre
ici — avant d'avoir dessiné un seul tuyau. C'est toute la raison de cet ordre.

**Lot 3 — Les objets proches.** Tuyaux, blocs `?`, pièces, en boîte.
→ *On juge :* la stéréo attrape-t-elle le volume à 7-9 m, et les gros pixels
tiennent-ils d'aussi près.

**Lot 4 — La vie.** `motion.ts` et le casting du §7.
→ *On juge :* le confort. C'est le seul lot qui peut donner la nausée.

## 10. Les tests, et ce qu'ils ne couvrent pas

**Sous Bun, en pur :**

- `pixels.ts` — grille → RGBA.
- Invariants de l'art — lignes de longueur égale, tout caractère présent dans
  la palette, toute palette pointant sur une couleur de `palette.ts`.
- `composition.ts` — **le plus utile**, parce qu'il tient trois règles
  qu'aucune relecture n'attrape :
  1. rien de décor en deçà de `DÉCOR_PROCHE` ;
  2. `RIDEAU` strictement entre l'écran et le décor — le test **recalcule le
     pire cas sur les 100 combinaisons de crans** (`SCREEN_DISTANCES` ×
     `SCREEN_ANGLES` × `SCREEN_HEIGHTS` × courbe/plat × `crt`/`square`)
     plutôt que de constater 5,281 m. Ajouter un cran de distance, ou un
     rapport de pixel plus haut, fera donc rougir ce test en nommant la
     cause ;
  3. le sol ne reçoit pas le `y` de l'ancre.
- `motion.ts` — un goomba fait demi-tour à ses bornes et n'en sort jamais ; la
  cadence est 8 Hz et pas 72.
- `floor.ts` — derrière son port : mesure, refus, repli.

**Le piège du dépôt, à ne pas re-payer :** une suite `core/test/` **ne tourne
jamais tant qu'elle n'est pas nommée dans `test:ui`** — c'est une liste
explicite d'une septantaine de fichiers dans `package.json`, pas un glob.
Chaque lot ajoute ses fichiers à cette ligne, et l'on surveille **le total** de
tests, pas la couleur.

**Ce qu'aucun test ne couvrira :** `build.ts`, comme le GLSL de
`picture-filter.ts`. L'instrument à la place est le rendu — la planche de
l'atlas en PNG et des vues du décor via esbuild + `file://`, à chaque lot.

## 11. Ce que seul un casque tranche

La liste explicite, pour que la première session sache quoi regarder :

1. La hauteur du sol paraît-elle juste, **assis et debout** ?
2. La parallaxe bat-elle le papier peint ? *(lot 2 — c'est le pari)*
3. Les pixels sont-ils gros comme voulu, ou seulement flous ? Rappel de
   méthode : « flou » veut souvent dire « trop petit ». Chercher une
   observation qui sépare *contenu* / *filtrage* / *taille*, et mesurer en
   degrés.
4. Le fondu est-il confortable **dans les deux sens** ?
5. Le compteur d'images tient-il dans le lobby ? *(§8)*
6. Le Guardian s'est-il mis à se comporter autrement depuis
   `optionalFeatures` ? *(§4.2)*

## 12. Ce qui n'est pas dans ce lot

Énoncé pour que personne ne l'ajoute « au cas où » :

- **Un seul monde.** Pas de thème souterrain, pas de château, pas de sélection.
  La structure de `composition.ts` ne s'y oppose pas ; rien ne la prépare non
  plus.
- **Aucun habillage des panneaux.** Décision du demandeur : on regarde d'abord
  si le contraste choque.
- **Aucun réglage utilisateur.** Ni hauteur de sol, ni choix de monde, ni
  intensité. §4.2 dit pourquoi.
- **Le décor pendant la partie.** Écarté par la réponse de cadrage.
- **Pas d'interaction avec le décor.** On ne casse pas un bloc, on ne vise pas
  un goomba. C'est un lieu, pas un jeu.
