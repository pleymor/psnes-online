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

## §3. La mémoire, sur le processeur — et pourquoi ce n'est plus le GPU

**Ce paragraphe disait le contraire, et la mesure l'a renversé.** Il raisonnait
sur dix calques : dix textures de 256×224 en RVBA téléversées à chaque image
font 137 Mo/s, donc il fallait des cibles de rendu persistantes que rien ne
traverse.

Une image de jeu réelle n'en contient **jamais dix**. Elle en contient **trois**
— mesuré sur 212 images, la distribution est un pic à trois et rien d'autre. Et
sur ces trois, seuls les FONDS méritent une mémoire (§3 bis), ce qui en laisse
deux. Le téléversement redouté n'existe pas : il vaut 27 Mo/s, là où la scène
en téléverse déjà un.

Le GPU perdait alors son seul avantage, et gardait son défaut : le verdict du
§4 compare la prédiction aux pixels réellement gagnés, et sur le GPU cette
comparaison demande de **relire** la carte à chaque image — une lecture qui vide
le pipeline, et qui coûte plus cher que tout ce qu'elle économise. Or l'image et
le masque **arrivent déjà sur le processeur**, venus du wasm. Le verdict s'y
calcule dans la même boucle que l'écriture, pour rien.

Coût mesuré sur 5 100 images : **0,30 ms en médiane**, 0,88 ms au 99ᵉ centile,
pour un budget de 13,9 ms à 72 Hz. Aucune image au-dessus de 5 ms.

L'atlas est un seul tampon, une couche par fond, et chaque mémoire est une VUE
dessus : `screen.ts` le donne à une `DataArrayTexture` sans une recopie.
**L'alpha porte le « déjà vu »**, ce qui supprime le second tableau de drapeaux
et l'occasion qu'il offrait aux deux de se contredire.

## §3 bis. Les sprites n'ont pas de trous, ils ont de la transparence

La décision que la première version de cette spec aurait fait manquer, et qui
aurait peint un aplat opaque en travers de l'image.

Sur une image de jeu réelle :

| calque | possède | « trou » |
|---|---|---|
| bg3.hi (barre d'état) | 1,8 % | 98,2 % |
| bg2.lo (le fond) | 88,6 % | 11,4 % |
| sprite | 9,6 % | 90,4 % |

Les 90 % de « trou » du plan des sprites ne sont pas un défaut : il n'y a pas de
sprite là, et c'est tout. Ce sont les 11,4 % du fond qui sont le défaut, et ils
ont exactement la forme des sprites qui passent devant — ce que l'utilisateur a
décrit mot pour mot : *« ce noir correspond aux formes dessinées sur les layers
proches »*.

**La règle ne demande aucun seuil réglé à la main** : seuls les fonds ont un
défilement, donc seuls les fonds ont quelque chose à recaler. Les sprites
bougent chacun pour soi, la toile de fond est un aplat. La règle tombe de
l'arithmétique.

**Et ce qui est vraiment transparent le reste, sans qu'on ait à le distinguer.**
Un pixel où un fond n'a jamais rien dessiné n'est gagné par lui dans AUCUNE
image : sa mémoire reste vierge, son alpha à zéro, et le shader se tait. Le
drapeau « déjà vu » fait le tri que l'octet de priorité ne permettrait pas —
celui-ci confond « ce calque était caché » et « ce calque était vide ».

## §3 ter. Un pixel de mémoire ne masque jamais un pixel réel

Le piège qui aurait rendu l'image fausse vue de face, et qui ne se voit pas en
lisant le code.

Les plans sont à des profondeurs différentes. Sans précaution, le remplissage
d'un plan PROCHE recouvre ce qu'un plan LOINTAIN dessine vraiment au même
endroit — une barre d'état mangée par le fond qu'on se souvient d'avoir vu
derrière elle. Le pixel comblé est donc écrit tout au fond du tampon de
profondeur (`gl_FragDepth`), ce qui le fait perdre contre **tout** ce qui est
réel, quel que soit le plan et quel que soit l'ordre de dessin. Un petit écart
par calque départage les mémoires entre elles, le plan le plus proche gagnant.

## §4. Le verdict, et le repli qui n'est pas construit

**Comment on sait que la mémoire ment.** Après recalage, les pixels que le
calque vient de gagner sont comparés à ce que la mémoire prévoyait au même
endroit. S'ils s'accordent, le défilement était juste. S'ils divergent au-delà
d'un seuil — HDMA, changement de scène, mode 7 — **la mémoire de ce calque est
jetée**, puis réapprise dans la même passe : les pixels de l'image en cours sont
justes par définition, et repartir totalement vierge ferait clignoter le
remplissage une image sur deux quand le verdict hésite.

**Un calque qui n'a RIEN gagné ne se juge pas.** Ne rien pouvoir vérifier est
une bonne réponse à « peut-on vérifier ? » et une mauvaise à « faut-il jeter ? ».
Un fond entièrement caché derrière un sprite plein écran est exactement le cas
où sa mémoire sert le plus ; la jeter pour n'avoir pas pu la vérifier
reviendrait à n'en avoir jamais.

C'est ce qui rend la promesse tenable : exacte quand elle peut l'être,
approximative quand elle ne peut pas, jamais fausse sans le savoir.

**Le signe du recalage a été tranché par la mesure**, et non deviné : sur 366
images où le défilement change, l'opposé du défilement laisse 13,81 % de
désaccord, le sens inverse 19,31 %, et ne rien recaler du tout 18,94 %. Le
mauvais signe fait donc PIRE que l'inaction, ce qui est sa signature — il
déplace la mémoire du double de l'erreur au lieu de l'annuler.
`tools/vr-relief/scroll-sign.ts` refait la mesure en dix minutes.

### Ce qui n'est PAS construit : la dilatation

Le repli annoncé par la première version de cette spec **n'existe pas**. Une
mémoire jetée ne dilate rien : le plan retombe sur le `discard`, c'est-à-dire
sur le trou d'aujourd'hui.

C'est un report délibéré, et voici l'argument. Une mémoire jetée est réapprise
dans la même passe, donc le trou ne dure qu'une image ; et la dilatation a un
défaut que le README de la sonde annonce lui-même — une bavure là où le calque
avait une arête franche contre un trou. Payer une bavure permanente pour une
image de trou n'est pas évidemment un bon change, et rien de ce qui se mesure
ici ne peut en décider. **C'est au casque de trancher**, et la question à poser
est précise : est-ce qu'un scintillement se voit aux changements de scène ?

## §5. Les modules

| module | ce qu'il gagne |
|---|---|
| `core/src/gfx_scroll.cpp` *(nouveau)* | `pn_bg_scroll()`, lecture seule, sur le modèle de `gfx_depth.cpp` |
| `core/src/psnes_core.c` | l'export vers le wasm |
| `znet/core.ts` | `scrollSurface()`, à côté de `depthSurface()` |
| `vr/layer-map.ts` | slot → calque, pour savoir quel défilement s'applique |
| `vr/slot-memory.ts` *(nouveau)* | l'arithmétique du recalage et du verdict, sans three |
| `vr/slot-fill.ts` *(nouveau)* | quels calques ont une mémoire, où elle vit, quand on la jette |
| `vr/picture-filter.ts` | la branche du trou dans le shader, et sa profondeur |
| `vr/screen.ts` | la `DataArrayTexture` et la passe par image |
| `tools/glsl-compile/` *(nouveau)* | compiler les shaders pour de vrai, ce qu'aucun test ne fait |
| `tools/vr-relief/scroll-sign.ts` *(nouveau)* | trancher le signe du recalage par la mesure |

## §6. Les tests

Ce qui se vérifie sous Bun, dans `slot-memory.ts` :

- Un défilement nul ne déplace rien.
- Un défilement d'un pixel déplace d'un pixel, dans le bon sens — le sens étant
  précisément ce que ce dépôt s'est trompé cinq fois à deviner.
- Ce qui sort du cadre ne revient pas par l'autre bord.
- Le verdict : une mémoire qui s'accorde est gardée, une qui diverge est jetée.
- Un pixel jamais vu est marqué comme tel, et n'est jamais servi comme s'il
  était connu.

Et ce qu'aucun de ces tests ne fait : **compiler un shader**. Les 1 234
assertions vérifient l'arithmétique AUTOUR du rendu, jamais le rendu. Un shader
qui ne compile pas ne casse donc rien ici — il donne un écran noir dans le
casque, à distance, sans message. D'où `tools/glsl-compile/`, un vrai WebGL2 en
SwiftShader qui rend en prime la liste des uniformes ACTIFS : un uniforme absent
de cette liste n'est lu par personne, donc la branche qui devait le lire a été
éliminée comme morte.

### Ce qui ne se vérifie que dans un casque

Et il faut dire ici ce qui n'a PAS pu l'être ailleurs. Ni l'une ni l'autre des
deux ROM disponibles n'atteint un niveau qui défile sous une manette
automatisée — cinq motifs d'appui ont été essayés, aucun ne passe les menus. Le
taux de remplissage mesuré (1 %) est donc celui d'un écran fixe, où il n'y a
rien à se rappeler et où la mémoire a raison de se taire. **Il ne dit rien du
cas qui compte.**

Ce qui a pu être établi sans casque : le signe du recalage (§4), le coût (§3),
la compilation du shader, et que les trois plans tiennent leurs promesses
arithmétiques. Ce qui reste à voir : si le remplissage se voit, s'il tient dans
un jeu qui défile vite, et si un scintillement apparaît aux changements de
scène.

## §7. Hors sujet

Le mode 7. Il n'a pas de calque au sens des autres, et le relief ne le sépare
pas aujourd'hui.
