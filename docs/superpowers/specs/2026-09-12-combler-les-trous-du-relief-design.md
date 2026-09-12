# Combler les trous du relief — design

Quand les calques s'écartent en profondeur, on voit du noir à travers les
calques lointains. Ce document dit comment y mettre le vrai décor.

## §0. Ce que le noir est, et ce qu'il n'est pas

Ce n'est pas une texture mal étirée : c'est un **trou d'information**.

Le cœur rend **une** image composée plus **un octet par pixel** disant quel
calque a gagné ce pixel (`GFX.ZBuffer`, exposé par `core/src/gfx_depth.cpp`).
Chaque plan du relief garde les pixels qu'il a gagnés et jette les autres, donc
tout ce qui est devant lui y laisse un trou — et un trou est exactement ce
qu'on voit à travers quand les plans s'écartent.

**La couleur du fond derrière un sprite n'a jamais été calculée.** Le PPU
compose et seul le vainqueur survit. Aucun traitement d'image ne peut la
retrouver dans la frame.

La largeur visible du trou vaut l'écart de profondeur multiplié par la tangente
de l'angle de vue. Au maximum réglable — 0,6 m d'écart × 1,5 de force — un
regard à 20° ouvre 33 cm sur l'écran, soit une trentaine de pixels sur 256.

## §1. La voie retenue, et les deux écartées

`tools/vr-relief/README.md` a pesé les trois il y a un an de développement, et
son verdict tient :

1. **Re-rendre calque par calque** avec `Settings.BG_Forced` — exact, mais il
   faut rejouer la frame depuis un savestate, et les effets raster se perdent.
   Écarté : rejouer une frame par image est hors budget, et perdre le dégradé
   du ciel pour gagner le fond derrière un goomba est un mauvais change.
2. **L'accumulation temporelle** — *« c'est la vraie réponse, et elle n'est pas
   implémentée »*. **Retenue.**
3. **La dilatation** — ce que la sonde fait, et ce qu'elle dit d'elle-même :
   *« a real-time version is a different problem and is not solved by this
   function »*. Ses 96 passes par calque sur dix calques sont hors budget en
   JavaScript à 60 images par seconde. Gardée comme **repli**, voir §4.

**Le principe de la voie retenue :** ce qui est caché maintenant était visible
il y a quelques images. On garde, par calque, ce qu'on a déjà vu ; on le
recale d'une image à l'autre par le défilement de ce calque ; et on s'en sert
pour remplir les trous.

## §2. Ce que le cœur doit dire de plus

Un seul ajout, sur le modèle exact de `gfx_depth.cpp` : **le défilement de
chaque calque**, en lecture seule, après la frame.

La propriété qui ne doit pas bouger est écrite dans l'en-tête de ce
fichier-là : *« a core built with this file still produces bit-identical frames
and savestates - the property lockstep netplay rests on »*. Un accesseur qui ne
lit rien d'autre que des registres déjà calculés la préserve par construction ;
c'est la seule forme autorisée ici.

**Et une limite qu'il faut dire tout de suite.** Un registre par image ne
décrit pas une image SNES : le HDMA change le défilement **par ligne**, et
c'est ainsi que se font les parallaxes et le ciel dégradé de Mario. Une seule
valeur par calque sera donc juste pour un défilement d'écran entier, et fausse
pour ces effets-là. D'où le repli du §4, sans lequel cette spec promettrait une
exactitude qu'elle ne tiendrait pas.

## §3. La mémoire, sur le GPU et non sur le processeur

Une cible de rendu persistante par calque, à la taille de l'image.

Chaque image, pour chaque calque : on recopie la cible sur elle-même décalée du
défilement écoulé, puis on y écrit les pixels que le calque vient de gagner. Le
plan du relief lit cette cible au lieu de l'image composée, et n'a plus de
trou.

**Sur le GPU parce que le transfert est le coût.** Dix textures de 256×224 en
RVBA téléversées à chaque image font 2,3 Mo par image, soit 137 Mo/s — là où la
scène n'en téléverse qu'une aujourd'hui. Une cible persistante ne traverse
jamais le bus : le recalage est un `blit` décalé, l'écriture est le rendu
habituel.

## §4. Le repli, et pourquoi il est nécessaire

**Comment on sait que la mémoire ment.** Après recalage, les pixels que le
calque vient de gagner sont comparés à ce que la mémoire prévoyait au même
endroit. S'ils s'accordent, le défilement était juste. S'ils divergent au-delà
d'un seuil — HDMA, changement de scène, mode 7 — **la mémoire de ce calque est
jetée** et le plan retombe sur la dilatation pour cette image.

C'est ce qui rend la promesse tenable : exacte quand elle peut l'être,
approximative quand elle ne peut pas, jamais fausse sans le savoir.

**La dilatation de repli est celle de la sonde**, portée sur le GPU en pyramide
de mip — quelques passes de rendu au lieu de 96 passes de boucle. Son défaut
reste celui que le README annonce : une bavure là où le calque avait une arête
franche contre un trou.

## §5. Les modules

| module | ce qu'il gagne |
|---|---|
| `core/src/gfx_scroll.cpp` *(nouveau)* | `pn_bg_scroll()`, lecture seule, sur le modèle de `gfx_depth.cpp` |
| `core/src/psnes_core.c` | l'export vers le wasm |
| `znet/core.ts` | `scrollSurface()`, à côté de `depthSurface()` |
| `vr/layer-map.ts` | slot → calque, pour savoir quel défilement s'applique |
| `vr/slot-memory.ts` *(nouveau)* | l'arithmétique du recalage et du verdict, sans three |
| `vr/screen.ts` | les cibles persistantes, les passes de recalage et de repli |

## §6. Les tests

Ce qui se vérifie sous Bun, dans `slot-memory.ts` :

- Un défilement nul ne déplace rien.
- Un défilement d'un pixel déplace d'un pixel, dans le bon sens — le sens étant
  précisément ce que ce dépôt s'est trompé cinq fois à deviner.
- Ce qui sort du cadre ne revient pas par l'autre bord.
- Le verdict : une mémoire qui s'accorde est gardée, une qui diverge est jetée.
- Un pixel jamais vu est marqué comme tel, et n'est jamais servi comme s'il
  était connu.

Ce qui ne se vérifie que dans un casque : si la bavure du repli se voit, et si
la mémoire tient assez longtemps pour servir à quelque chose dans un jeu qui
défile vite.

## §7. Hors sujet

Le mode 7. Il n'a pas de calque au sens des autres, et le relief ne le sépare
pas aujourd'hui.
