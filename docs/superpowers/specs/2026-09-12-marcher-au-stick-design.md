# Marcher au stick dans le lobby VR — design

Se déplacer de quelques pas autour de son bureau, au stick gauche, sans nausée.

## §0. Ce que ça n'est pas

**Ce n'est pas de l'exploration.** Le rayon est de trois mètres, et ce chiffre
n'est pas une timidité : il est ce que le monde peut porter.

Trois faits, vérifiés avant d'écrire une ligne :

- **Le décor est un diorama centré sur le joueur.** Les collines sont sur un
  anneau à 20 m, les nuages à 15, les tuyaux à 9, tous centrés sur l'ancre. À
  dix mètres du centre, une colline à 20 m se retrouve à 10 d'un côté et 30 de
  l'autre : la couronne de panneaux plats se révèle pour ce qu'elle est.
- **Le rideau est une sphère de 5,5 m centrée sur l'ancre.** En sortir, c'est
  sortir de ce qui masque le monde quand une partie tourne.
- **Le lobby est du mobilier autour du joueur.** Pupitres à ±60° et 1,06 m,
  comptoir qui les épouse, tablette à 1,5 m. S'en éloigner, c'est laisser son
  interface derrière soi.

À trois mètres, aucun des trois ne casse. C'est du confort de posture —
contourner le comptoir, s'approcher d'un tuyau, reculer pour voir l'écran de
plus loin — et non un changement de nature du lobby.

**Ce n'est pas disponible pendant une partie.** Le stick EST la croix
directionnelle de la SNES (`vr/pad.ts`). Il n'est libre qu'au lobby.

## §1. La décision, en fonction pure

`vr/walk.ts`, sans three, testable sous Bun comme toute géométrie de ce projet.

```ts
export interface WalkInput {
  /** Le décalage courant du monde, en mètres, dans le plan. */
  readonly offset: readonly [number, number];
  /** Les deux axes du stick, bruts. */
  readonly stick: readonly [number, number];
  /** L'avant de la caméra, à plat et normalisé. */
  readonly forward: readonly [number, number];
  /** La droite de la caméra, à plat et normalisée. */
  readonly right: readonly [number, number];
  /** Secondes depuis l'image précédente. */
  readonly dt: number;
}

export function walk(input: WalkInput): [number, number];
/** La vitesse du dernier pas, en m/s, pour piloter la vignette. */
export function walkSpeed(before: readonly [number, number], after: readonly [number, number], dt: number): number;
```

**Deux vecteurs plutôt qu'un angle, et c'est le point de conception.** Ce dépôt
a payé trois erreurs de signe sur des conventions de repère dans la seule
journée du 2026-09-11 : les boîtes du décor tournées de 180° parce qu'un quad
regarde +Z et une boîte -Z ; le bord bas d'un panneau, dont la composante z
change de signe avec le tangage ; la tangente du comptoir. Une fonction qui
reçoit l'avant et la droite tout faits n'a **aucune convention à se tromper**,
et surtout son test ne peut pas être dupe de la même erreur que le code — ce
qui arriverait si les deux dérivaient l'angle de la même façon.

La seule convention qui reste est celle de la manette, et elle est documentée
là où elle s'applique : **l'axe Y d'un stick est négatif vers l'avant**.

### Les nombres

| | | |
|---|---|---|
| zone morte | **0,15** | |
| rampe | **quadratique** | une poussée légère avance lentement |
| vitesse maximale | **1,2 m/s** | trois mètres en deux secondes et demie |
| rayon | **3 m** | ce que le diorama et le rideau supportent |

**La zone morte n'est PAS `XR_AXIS_THRESHOLD`.** Ce seuil vaut 0,5 et il est
partagé avec le mode à plat « so a stick feels the same in both modes » : il
sert à décider si une croix directionnelle est pressée, ce qui est une question
binaire. Un demi-débattement mort sur une marche donnerait un départ en
sursaut. Les deux nombres répondent à deux questions différentes et ne doivent
pas être partagés ; le code le dira.

**La borne projette, elle n'arrête pas.** Arrivé au bord du disque, le
déplacement est reprojeté dessus : on glisse le long plutôt que de se cogner.
Une butée franche se sent comme un bug ; un glissement se sent comme un mur.

## §2. Le câblage

| module | ce qu'il gagne |
|---|---|
| `vr/walk.ts` *(nouveau)* | `walk`, `walkSpeed`, et les quatre constantes |
| `vr/scene.ts` | `setWalk(offset)` : le décalage s'ajoute à la position des DEUX groupes, `world` et `room`. Et `headBasis()`, qui rend l'avant et la droite de la caméra, à plat et normalisés. |
| `vr/vignette.ts` *(nouveau)* | le maillage assombrissant, enfant de la caméra |
| `components/VrShell.svelte` | lire le stick au lobby, appeler `walk`, poser le décalage et l'opacité |

**Les deux groupes, et non un.** `world` porte les panneaux, le rideau et le
comptoir ; `room` porte le décor. Les décaler du même vecteur fait glisser le
monde ENTIER autour du joueur — meubles compris — donc il marche par rapport à
son bureau au lieu de le traîner. Décaler un seul des deux les séparerait, ce
que `build.ts` interdit déjà pour la hauteur.

**« Recentrer » remet le décalage à zéro.** Ce bouton existe pour un joueur qui
s'est perdu ; le laisser à trois mètres de son bureau après l'avoir pressé
serait le contraire de ce qu'il promet.

**`headBasis()` existe parce que `headPosition()` ne suffit pas.** La scène
n'expose aujourd'hui que la position de la caméra de tableau — assez pour
orienter un billboard, pas pour savoir où le joueur regarde. Les deux vecteurs
sont tirés de sa matrice monde, aplatis et normalisés, dans le seul module qui
tienne la caméra ; c'est ce qui permet à `walk.ts` de n'avoir aucune convention
de repère à porter. Le cas dégénéré est celui que `anchor.ts` documente déjà :
tête franchement vers le haut ou le bas, l'avant aplati devient trop court pour
donner un cap, et `headBasis` reprend alors la même parade que `anchorFrom` —
prendre le cap sur le vecteur haut de la tête.

**La vignette** est un maillage enfant de la caméra, donc toujours devant les
yeux, avec une opacité pilotée par `walkSpeed`. Nette à l'arrêt : une vignette
permanente coûterait du champ pour rien. Le vertige vient du défilement en
périphérie, et c'est là qu'elle agit.

## §3. Les tests, tous sans casque

- La zone morte tient : sous 0,15 de débattement, le décalage ne bouge pas
  d'un flottant.
- La rampe est monotone : pousser plus fort n'avance jamais moins vite.
- La vitesse ne dépasse jamais son plafond, **diagonale comprise** — c'est
  l'erreur classique, où pousser en biais donne √2 fois la vitesse.
- Le décalage ne sort jamais du disque, sur mille poussées tirées au hasard.
- Un stick au repos ne dérive pas, même après mille images.
- `walkSpeed` rend zéro pour un déplacement nul et le bon quotient sinon.

Ce qu'aucun test ne dira : si 1,2 m/s est confortable, et si la vignette est
assez sombre. Une session casque, et les deux leviers sont des constantes.

## §4. Hors sujet

Tourner au stick. La rotation est la première cause de nausée en VR, bien avant
la translation, et elle n'est pas nécessaire ici : le joueur est assis dans un
lobby qui l'entoure, il tourne la tête. Si le besoin apparaît, la réponse
standard est la rotation par crans, pas la rotation continue — et ce sera une
autre spec.
