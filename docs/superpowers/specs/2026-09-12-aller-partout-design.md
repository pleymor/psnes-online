# Aller partout, et tourner au stick — design

Lever la borne des trois mètres, et tourner sur soi au stick droit.

Suite de `2026-09-12-marcher-au-stick-design.md`, dont ce document annule deux
décisions : le rayon de trois mètres (§0) et le renvoi de la rotation hors
sujet (§4). Les raisons qui les motivaient restent vraies — elles sont
seulement payées autrement.

## §1. Le monde se coupe en deux

C'est la décision qui porte tout le reste.

Aujourd'hui, tout le décor vit sur des anneaux **centrés sur l'ancre** :
collines à 20 m, nuages à 15, créatures à 12, tuyaux à 9, blocs à 7. Le sol est
un disque de 30 m, le ciel une sphère de 30, le rideau une sphère de 5,5. À
trois mètres tout cela tient ; à trente, on sort du sol et du ciel, et la
couronne de panneaux plats se révèle pour ce qu'elle est.

La réponse est de séparer le décor en deux familles, selon qu'il **suit le
joueur** ou qu'il **reste posé** :

| suit | reste |
|---|---|
| le ciel | le comptoir et les trois pupitres |
| le sol | l'écran et la tablette |
| le rideau | les tuyaux et les blocs `?` |
| les collines, les nuages | les goombas, la plante |
| | les buissons |

On marche donc dans une **plaine sans fin** : l'horizon ne s'approche jamais,
mais le bureau s'éloigne vraiment, et on fait le tour d'un tuyau.

**Ce que ça coûte, dit franchement :** les collines ne seront jamais atteintes.
C'est l'effet « plaine infinie », connu et accepté ici parce que l'alternative
— poser un vrai terrain — est un lot entier, et parce que ce lobby est un
endroit où l'on choisit un jeu, pas un monde où l'on part en promenade.

**Ce que ça rapporte en plus :** le rideau suit le joueur, donc il reste une
cagoule autour de sa tête au lieu d'être un endroit qu'on peut quitter. Sans
ça, marcher six mètres pendant une partie ferait réapparaître le monde.

### Comment

`decor/build.ts` rend aujourd'hui trois racines — `decor`, `curtain`,
`furniture`. Il en rendra **quatre**, la nouvelle étant `far` : ce qui suit le
joueur. `scene.ts` place `far` et `curtain` sur le joueur à chaque image, et
laisse `decor` et `furniture` où ils sont.

**Le découpage n'est PAS un seuil de rayon**, et cette spec l'a d'abord écrit
ainsi avant de se relire. `scenery()` pose des buissons sur l'anneau des
créatures (12 m) ET sur celui des nuages (15 m) : n'importe quel seuil entre
les deux ferait suivre la moitié des buissons et rester l'autre moitié — des
buissons qui se dédoublent dès qu'on marche.

Le découpage est donc **déclaré**, par un drapeau `distant` sur `Prop`. Ce qui
le porte : les collines et les nuages, et rien d'autre. Le sol, le ciel et le
rideau ne sont pas des `Prop` et suivent par construction. Un test vérifie que
chaque élément le déclare, et qu'aucun objet en deçà de l'anneau des créatures
ne se déclare lointain — la règle de bon sens que le drapeau seul ne donne
pas.

## §2. Tourner, des deux façons

Le joueur choisit. **Par crans de 30° par défaut**, avec un fondu au noir d'un
quart de seconde : c'est le standard VR, parce qu'une rotation continue fait
tourner TOUT le champ alors qu'une translation n'en fait défiler qu'une partie,
et que l'oreille interne ne sent aucun virage. La rotation continue existe
aussi, avec la vignette de la marche, pour ceux que ça ne gêne pas.

Le réglage vit sur la tablette d'options, à côté des autres, et persiste comme
eux.

**La rotation se fait autour du JOUEUR, pas autour de l'ancre.** C'est le piège
de cette section : les groupes sont placés à l'ancre moins la position du
joueur, donc les faire tourner sur leur origine ferait décrire au joueur un
arc autour d'un point où il n'est pas. La formule est celle d'une rotation
autour d'un point — tourner la position, puis la replacer — et elle vit dans
un module pur, testée, parce que c'est exactement le genre d'arithmétique que
ce dépôt s'est trompé quatre fois à faire de tête.

## §3. Les modules

| module | ce qu'il gagne |
|---|---|
| `vr/walk.ts` | `WALK_RADIUS` disparaît ; `turn(...)` et `snapTurn(...)`, purs |
| `vr/scene.ts` | `setPlayerAt(position, yaw)` ; `far` et `curtain` suivent le joueur |
| `decor/build.ts` | la quatrième racine, `far`, remplie d'après le drapeau |
| `decor/placement.ts` | le drapeau `distant` sur `Prop` |
| `vr/panels/options.ts` | le réglage de rotation |
| `components/VrShell.svelte` | le stick droit, et la persistance du réglage |

## §4. Les tests

- Un cran fait exactement 30°, et douze crans font un tour complet à l'epsilon
  près.
- La rotation continue ne dépasse jamais sa vitesse maximale.
- **Tourner autour du joueur ne le déplace pas** : sa position dans le monde
  est invariante par rotation, à l'epsilon près. C'est l'assertion qui attrape
  la faute de cette section.
- Le lacet reste borné dans un tour, sans dérive après mille crans.
- Chaque élément du relief déclare s'il est lointain, et seuls les collines et
  les nuages le sont.
- Aucun élément en deçà de l'anneau des créatures ne se déclare lointain : le
  drapeau dit ce qui suit, cette règle dit ce qui n'a pas le droit de suivre.

## §5. Ce qui reste hors sujet

Se déplacer pendant une partie. Le stick reste la croix de la SNES, et le
stick droit y porte le menu.
