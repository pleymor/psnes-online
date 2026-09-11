# Le comptoir en blocs Mario — design

Remplacer les trois pupitres flottants du lobby VR — bibliothèque, amis,
profil — par un comptoir en U fait de blocs de brique Mario, sur lequel ils
reposent.

## §0. Ce que ça change, et ce que ça ne change pas

**Les trois panneaux ne bougent pas d'un millimètre.** Position, inclinaison,
taille, canevas, pointeur : tout reste. Ce qui change est ce qu'il y a
*dessous*. C'est un choix délibéré : la lisibilité de ces panneaux a été
réglée à l'œil dans un casque (`layout.ts` raconte le passage de 30,5 à 44,8
degrés de champ), et un comptoir n'est pas une raison de la rejouer.

Le comptoir est donc du **mobilier**, pas une interface. Il ne reçoit aucun
pointeur, ne porte aucun texte, et ne peut rien casser de ce qui fonctionne.

## §1. Les quatre contraintes, toutes vérifiées avant d'écrire

Elles ne sont pas des précautions : chacune a éliminé une conception qui
semblait raisonnable.

**1. Deux racines, et le comptoir doit choisir la bonne.** Les panneaux vivent
dans le groupe `world`, ancré sur le joueur ; le décor Mario dans `room`, dont
le `y` ne suit PAS l'ancre — sans quoi le sol monterait avec le joueur.
L'en-tête de `decor/build.ts` le dit : « les mettre ensemble casse l'un ou
l'autre ». Un comptoir posé dans `room` glisserait verticalement sous les
panneaux qu'il est censé épouser, jusqu'à `ANCHOR_DRIFT`, 80 cm. **Le comptoir
va donc dans `world`, avec les panneaux.**

**2. Il ne doit jamais connaître la hauteur du sol.** Conséquence directe de
la précédente : le sol est mesuré (`measureFloor`, 1,596 m dans l'émulateur,
repli à 1,2) et vit dans l'autre groupe. Un comptoir « posé au sol » flotterait
ou s'enfoncerait au premier recentrage. Il descend donc **plus bas que tout sol
plausible**, et le disque du sol enterre l'excédent. Aucune mesure, aucun
couplage.

**3. Le rideau n'a rien à faire ici.** À 1 m, le comptoir est à l'intérieur du
rideau (5,5 m), qui noircit le monde pendant une partie — et aujourd'hui « le
sol est le seul objet du décor en deçà de son rayon, donc lui seul a besoin de
son propre fondu ». Mais les six sites qui basculent lobby/jeu appellent
`showDecor(false)` **et** `scene.panelsVisible(false)` ensemble. En pendant
dans le **groupe des panneaux**, le comptoir hérite de leur visibilité : aucun
fondu, aucun état nouveau, et il lui est impossible de rester allumé pendant
une partie.

**4. Une boîte tire sa taille de son art.** `boxFor` calcule largeur et hauteur
en divisant les pixels du motif par seize, et tout le décor refuse la mise à
l'échelle : « grossir un objet se fait en le dessinant plus grand ». Un
comptoir de longueur arbitraire est donc impossible sans trahir cette règle.
**Il est fait de vrais blocs d'un mètre** — ce qui est précisément ce que
« une table en blocs de Mario » veut dire.

## §2. La géométrie, dérivée et non choisie

Les trois panneaux ne sont pas à la même hauteur, et c'est le fait qui
structure tout le reste.

`counterRuns(layout)` vit dans `layout.ts` — module sans three, donc vérifiable
sous Bun sans casque, comme tout ce qui décide d'une géométrie dans ce projet.
Il déduit de chaque panneau **le milieu de son bord bas**, en appliquant son
inclinaison puis son lacet à `(0, -hauteur/2, 0)` :

| panneau | position du bord bas | |
|---|---|---|
| bibliothèque | `(-0.720, -0.723, -0.415)` | incliné de 40°, à 1,06 m |
| profil | `( 0.000, -0.836, -0.877)` | incliné de 55°, à 1,00 m |
| amis | `( 0.720, -0.723, -0.415)` | |

Le bandeau profil pend **onze centimètres plus bas** que les deux latéraux,
parce qu'il est plus incliné et plus bas sur son axe. Un plateau plat ne peut
pas épouser les trois : au niveau des latéraux il engloutirait 37 % du
bandeau ; au niveau du bandeau il laisserait les latéraux flotter. Le U porte
donc **un décrochement de onze centimètres sur son fond**, qui se lit comme une
tablette basse. Ce n'est pas un parti pris, c'est ce que les nombres imposent.

Un bloc par panneau, sommet exactement sur son point, à son lacet. **Déplacer
un pupitre déplace son bloc** : l'écart n'est pas surveillé, il est impossible,
parce qu'aucune position n'est écrite deux fois.

Le U est fait de **trois blocs**, un par panneau, et de rien d'autre.

Cette spec s'est trompée deux fois sur ce point, et la trace en reste ici parce
que la leçon vaut plus que la correction. Elle a d'abord dit « cinq blocs »,
avec deux blocs d'angle pour fermer un intervalle de 4,2 cm — alors qu'un bloc
fait un mètre, sa taille venant de son art. Puis « trois blocs décalés de
2,1 cm » pour fermer ce même intervalle. Les 4,2 cm étaient la distance entre
deux **milieux d'arêtes**, ce qui ne dit rien de l'intervalle entre deux
rectangles tournés de 60° l'un par rapport à l'autre.

Le vrai test, fait en plan sur des rectangles de 1 × 0,35 m : le coin intérieur
du bloc latéral tombe en `(-0.318, -0.761)`, **dans** le rectangle du bloc de
fond qui couvre `x ∈ [-0.5, 0.5]`, `z ∈ [-1.052, -0.702]`. Les blocs se
recouvrent déjà. Rien à fermer, rien à décaler.

**La continuité du U est donc une assertion du test, pas une phrase d'ici** :
chaque paire de tronçons voisins doit se recouvrir en plan. Si un réglage de
panneau la rompt un jour, le test rougit et le nomme — ce qu'aucune prose ne
sait faire.

`CounterRun` porte une **position explicite** et un champ `facing`, pas un
rayon : les blocs d'angle bissectent et ne sont sur aucun anneau propre.
`facing` est l'azimut **vers lequel la face avant regarde**, et non celui où le
bloc est posé — les deux coïncident sous un panneau, jamais dans un angle. Le
lacet reste calculé par **`boxYaw(facing)`**, pour que le piège +Z/−Z — qui a
retourné tout le décor proche de 180° le 2026-09-11 — reste enfermé à un seul
endroit.

## §3. L'art

Un motif nouveau, `COUNTER_BRICK`, **16 × 32 pixels : un mètre de large, deux
de haut**. Les deux mètres sont la contrainte n° 2 rendue en pixels — seuls les
**87 cm du haut se voient sous les blocs latéraux, 76 sous celui du fond**
(1,596 m de sol moins 0,723 et 0,836), et le reste est enterré quelle que soit
la taille du joueur.

La brique est le bon motif et pour une raison précise : `GROUND_BRICK` a été
retiré du sol parce qu'« une brique est une ÉLÉVATION, vue de face, alors qu'un
sol se voit du dessus ». La face avant d'un comptoir est justement une
élévation. Le flanc reprend la teinte assombrie, comme tous les flancs du lot 3.

Le dessus est un **aplat clair sans contour**. La leçon du sol s'applique mot
pour mot : carrelé, un bord sombre redessine une grille régulière tous les
mètres, que l'œil lit comme un artefact plutôt que comme une matière.

Les trois motifs sont inscrits dans `ALL_ART`, donc balayés par les invariants
existants sans que le test les connaisse — et un motif non inscrit ne serait
vérifié par rien.

## §4. Les modules

| module | ce qu'il gagne |
|---|---|
| `vr/layout.ts` | `counterRuns(layout)` et le type `CounterRun` |
| `decor/art/furniture.ts` *(nouveau)* | `COUNTER_BRICK`, son flanc, son dessus — trois motifs, aucun d'angle |
| `decor/art/index.ts` | les trois inscriptions au registre |
| `decor/build.ts` | `DecorOptions.counter` ; `Decor.furniture`, troisième racine |
| `vr/scene.ts` | `addFurniture`, qui ajoute au **groupe des panneaux** |
| `components/VrShell.svelte` | passer `counterRuns(layout)`, brancher la racine |

La troisième racine n'invente rien : `curtain` est déjà créé par `createDecor`
et vit dans `world`. `addFurniture` est le jumeau de `addDecor` et
`addCurtain`.

**Le seul nombre libre de tout le design est la profondeur du comptoir,
0,35 m**, **centrée** sur le bord bas du panneau : le plateau déborde de
17,5 cm vers le joueur autant qu'il s'enfonce derrière, comme un bureau dont
l'écran est au fond.

Ce centrage n'est pas un goût, c'est le test de continuité qui l'a imposé. La
profondeur partait d'abord du bord bas **en s'éloignant** — et les trois
tronçons reculaient alors chacun de leur côté, laissant 2,8 cm de trou à chaque
jonction. Quatrième erreur de géométrie de cette spec, et la première qu'une
assertion a attrapée au lieu d'une relecture. Tout le reste est dérivé.

## §5. Les tests, tous sans casque

- `counterRuns` recalcule **indépendamment** le bord bas de chaque panneau et
  exige que le sommet du bloc y soit. C'est le test qui rend l'écart
  impossible ; le reste en découle.
- Cinq tronçons, et aucun intervalle subsistant entre voisins.
- Les motifs nouveaux : rien à écrire, les invariants du registre les balaient
  dès leur inscription.
- L'absence de `floorHeight` dans `CounterRun` est structurelle — il n'y a pas
  de champ à oublier, donc rien à tester.

Ce que les tests **ne** peuvent pas dire, et qui demande une session casque :
si le comptoir est à la bonne distance pour qu'on ait envie d'y poser les
coudes, et si sa masse de brique écrase les panneaux ou les porte.

## §6. Les trois points laissés ouverts

**Le cadre des panneaux.** Ils gardent leur bordure bleue et leur fond blanc.
Posés sur de la brique, ces cadres pourraient détonner — mais c'est une
question qu'un rendu tranche mieux qu'un raisonnement, et la trancher d'avance
ferait bouger des panneaux dont ce design promet qu'ils ne bougent pas. À
regarder dans le casque, à corriger dans un second temps si besoin.

**La profondeur, 0,35 m.** Le seul nombre qui ne se déduit de rien. À juger sur
place.

**L'encoche des angles.** Deux boîtes droites qui se rejoignent à 60° ne
peuvent pas s'abouter à plat. Elles s'interpénètrent du côté intérieur — ce qui
est invisible, même brique, faces non coplanaires — et laissent une **encoche
d'environ 20 cm sur le bord arrière** du plateau, du côté opposé au joueur. Vue
d'un œil assis, c'est une morsure en V dans l'arête du fond. La supprimer
demanderait un motif d'angle taillé, dessiné pour un détail qu'on ne verra
peut-être jamais : à regarder dans le casque avant de le payer.

## §7. Hors sujet

Le damier noir et blanc de l'écran de test (`screen.showTestPattern()`) doit
lui aussi passer au thème Mario. C'est une pièce **indépendante** : autre
module, autres contraintes, aucun couplage avec le mobilier. Elle aura sa spec
et son plan.
